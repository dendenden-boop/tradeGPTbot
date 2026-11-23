// Work only from the reply of the fixed, authenticated capture RPC. PostgreSQL
// materializes the one RPC call so the proof and the reply share its locks and
// exact data, including on reconciliation reads.
export const currentOrderRiskCaptureQuery = `
WITH capture AS MATERIALIZED (
  SELECT ctp_paper.reconcile_admission($1::jsonb) AS result
), certificate AS MATERIALIZED (
  SELECT (result #>> '{certificate,text}')::jsonb AS document,
         result->'target' AS target,
         result #> '{target,command}' AS command,
         result #> '{target,owner}' AS target_owner,
         (result #>> '{target,createdAt}')::bigint AS target_created_at
  FROM capture WHERE result->>'kind' = 'CAPTURED'
), inputs AS MATERIALIZED (
  SELECT document, target, command, target_created_at,
         (document #>> '{source,market,snapshot,text}')::jsonb AS snapshot,
         (document #>> '{source,inventory,text}')::jsonb #> '{executed,execution}' AS execution
  FROM certificate
), price_inputs AS (
  SELECT command #>> '{size,value}' AS quantity, command, snapshot,
         (document #>> '{source,market,trade,text}')::jsonb->'trade' AS trade,
         CASE command->>'type' WHEN 'LIMIT' THEN command->>'limitPrice'
                              WHEN 'MARKET' THEN snapshot #>> '{record,rules,maxPrice}' END AS ceiling,
         (snapshot #>> '{record,rules,tickSize}')::numeric AS tick,
         (snapshot #>> '{record,rules,stepSize}')::numeric AS lot,
         snapshot #>> '{record,instrument,quoteAsset}' AS asset,
         execution #> '{effects,state}' AS book,
         (cfg.model->>'takerFeeRate')::numeric AS fee_rate,
         (cfg.model->>'participationRate')::numeric AS participation
  FROM inputs
  CROSS JOIN LATERAL (
    SELECT (execution #>> '{source,started,context,configuration,receiptText}')::jsonb
           #> '{configuration,model}' AS model
  ) cfg
  WHERE command->>'side' = 'BUY' AND command #>> '{size,kind}' = 'BASE_QUANTITY'
), sized AS (
  SELECT quantity::numeric AS quantity, lot, tick, asset, book, fee_rate,
         command, snapshot, trade, participation,
         div(ceiling::numeric, nullif(tick, 0)) * tick AS maximum
  FROM price_inputs
), debit AS (
  SELECT asset, book, principal_atoms * 1e-18::numeric AS notional,
         (principal_atoms
          + div(quantity, nullif(lot, 0)) * ceil(lot * maximum * fee_rate * 1e18::numeric))
         * 1e-18::numeric AS amount
  FROM sized
  CROSS JOIN LATERAL (SELECT ceil(quantity * maximum * 1e18::numeric) AS principal_atoms) principal
  WHERE quantity > 0 AND maximum > 0 AND lot > 0
    AND mod(quantity, nullif(lot, 0)) = 0 AND fee_rate >= 0
), cash AS (
  SELECT d.asset, d.amount, d.notional, balance.available - coalesce(held.amount, 0) AS available
  FROM debit d
  CROSS JOIN LATERAL (
    SELECT max((b.value->>'available')::numeric) AS available
    FROM jsonb_array_elements(d.book->'balances') b WHERE b.value->>'asset' = d.asset
    HAVING count(*) = 1
  ) balance
  CROSS JOIN LATERAL (
    SELECT sum((h.value->>'amount')::numeric) AS amount
    FROM jsonb_array_elements(d.book->'holds') h
    WHERE h.value->>'asset' = d.asset AND h.value->'reflected' = 'false'::jsonb
  ) held
), prior_exposure AS (
  SELECT document, target_created_at,
         (execution #>> '{effects,order,executedQuantity}')::numeric AS filled,
         (execution #>> '{effects,order,remainingQuantity}')::numeric AS pending,
         (snapshot #>> '{ticker,last,value}')::numeric AS mark,
         CASE execution #>> '{effects,reservation,status}'
           WHEN 'ACTIVE' THEN 1 WHEN 'RELEASED' THEN 0
         END AS open_orders,
         CASE execution #>> '{input,attempt,request,admission,command,type}'
           WHEN 'LIMIT' THEN (execution #>> '{input,attempt,request,admission,command,limitPrice}')::numeric
           WHEN 'MARKET' THEN (execution #>> '{input,original,record,rules,maxPrice}')::numeric
         END AS original_ceiling,
         (execution #>> '{input,original,record,rules,tickSize}')::numeric AS original_tick
  FROM inputs
), exposure AS (
  -- This certificate supports one executed order, one instrument and pristine
  -- siblings. The live residual uses its original ceiling, even after a rule refresh.
  SELECT document, open_orders, notional, available - amount AS remaining,
         filled * mark + CASE open_orders WHEN 0 THEN 0
           WHEN 1 THEN pending * div(original_ceiling, nullif(original_tick, 0)) * original_tick
         END AS current_exposure,
         CASE WHEN filled > 0 OR open_orders = 1 THEN 1 ELSE 0 END AS potential_positions,
         (document #>> '{source,ordersInLastMinute}')::integer
           + CASE WHEN target_created_at < (document->>'createdAt')::bigint - 60000
                  THEN 1 ELSE 0 END AS orders_in_minute
  FROM prior_exposure CROSS JOIN cash
  WHERE filled >= 0 AND pending >= 0 AND mark > 0 AND open_orders IS NOT NULL
    AND target_created_at BETWEEN 0 AND (document->>'createdAt')::bigint
), projected AS (
  SELECT *, current_exposure + notional AS projected_exposure
  FROM exposure
), market_facts AS (
  SELECT asset, quantity, tick, lot, participation, maximum, command,
         (snapshot #>> '{book,bids,0,price}')::numeric AS bid,
         (snapshot #>> '{book,asks,0,price}')::numeric AS ask,
         (snapshot #>> '{book,bids,0,quantity}')::numeric AS bid_size,
         (snapshot #>> '{book,asks,0,quantity}')::numeric AS ask_size,
         (trade->>'quantity')::numeric AS trade_size,
         CASE WHEN snapshot #>> '{ticker,last,state}' = 'AVAILABLE'
              THEN (snapshot #>> '{ticker,last,value}')::numeric END AS reference,
         greatest(tick, (snapshot #>> '{record,rules,minPrice}')::numeric) AS lower_bound,
         (snapshot #>> '{record,rules,minNotional}')::numeric AS min_notional,
         (snapshot #>> '{record,rules,maxNotional}')::numeric AS max_notional
  FROM sized
), market AS (
  -- Exact positive lot rounding and price bounds. A missing input must never
  -- be ignored by PostgreSQL's null-tolerant LEAST.
  SELECT *, (div(lower_bound, nullif(tick, 0))
         + CASE WHEN mod(lower_bound, nullif(tick, 0)) = 0 THEN 0 ELSE 1 END) * tick AS minimum,
         (command->>'limitPrice')::numeric AS limit_price,
         CASE WHEN bid_size > 0 AND ask_size > 0 AND trade_size > 0 AND participation > 0
           THEN floor(div(least(bid_size, ask_size, trade_size) * participation, nullif(lot, 0))
                      * lot * least(bid, ask) * 1e18::numeric) * 1e-18::numeric
         END AS liquidity
  FROM market_facts
), loss AS (
  SELECT (evidence->>'utcDayStart')::bigint AS day_start,
         evidence->'complete' = 'true'::jsonb AS complete,
         (evidence->>'adjustedOpeningEquity')::numeric AS opening,
         (evidence->>'adjustedCurrentEquity')::numeric AS equity,
         (evidence->>'adjustedPeakEquity')::numeric AS peak,
         -(evidence->>'dailyNetRealizedPnl')::numeric AS realized_loss
  FROM certificate
  CROSS JOIN LATERAL (SELECT (document #>> '{source,loss,text}')::jsonb AS evidence) sealed
), budget AS (
  SELECT projected.*, policy.within_limits, policy.market_allowed, policy.loss_allowed, market.liquidity
  FROM projected CROSS JOIN market CROSS JOIN loss
  CROSS JOIN LATERAL (
    SELECT count(*) = 2
      AND count(*) FILTER (WHERE p.value #>> '{scope,kind}' = 'PLATFORM') = 1
      AND count(*) FILTER (WHERE p.value #>> '{scope,kind}' = 'USER') = 1
      AND bool_and((
        notional <= (l.limits->>'maxOrderNotional')::numeric
        AND projected_exposure <= (l.limits->>'maxInstrumentExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxAssetExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxAccountExposure')::numeric
        AND projected_exposure <= (l.limits->>'maxUserExposure')::numeric
        AND remaining >= (l.limits->>'minAvailableBalance')::numeric
        AND open_orders + 1 <= (l.limits->>'maxOpenOrders')::integer
        AND 1 <= (l.limits->>'maxConcurrentPositions')::integer
        AND orders_in_minute BETWEEN 1 AND (l.limits->>'maxOrdersPerMinute')::integer
      ) IS TRUE) AS within_limits,
      bool_and((
        asset = l.limits->>'valuationAsset'
        AND 1 <= (l.limits->>'maxLeverage')::numeric
        AND reference > 0 AND bid > 0 AND bid <= ask
        AND minimum <= bid AND maximum >= ask AND minimum <= maximum
        AND quantity * coalesce(limit_price, minimum) >= min_notional
        AND (max_notional IS NULL OR quantity * coalesce(limit_price, maximum) <= max_notional)
        AND abs(coalesce(limit_price, minimum) - reference)
              <= reference * (l.limits->>'maxPriceDeviationRate')::numeric
        AND abs(coalesce(limit_price, maximum) - reference)
              <= reference * (l.limits->>'maxPriceDeviationRate')::numeric
        AND ask - bid <= reference * (l.limits->>'maxSpreadRate')::numeric
        AND liquidity >= notional AND liquidity >= (l.limits->>'minLiquidityNotional')::numeric
      ) IS TRUE) AS market_allowed,
      bool_and((
        complete AND day_start = ((document->>'createdAt')::bigint / 86400000) * 86400000
        AND opening > 0 AND equity > 0 AND peak >= opening AND peak >= equity
        AND (realized_loss <= 0 OR realized_loss < (l.limits->>'maxDailyRealizedLoss')::numeric)
        AND (opening <= equity OR opening - equity < (l.limits->>'maxDailyTotalLoss')::numeric)
        AND (peak <= equity OR peak - equity < peak * (l.limits->>'maxDrawdownRate')::numeric)
      ) IS TRUE) AS loss_allowed
    FROM jsonb_array_elements(document #> '{source,policies}') p
    CROSS JOIN LATERAL (SELECT p.value->'limits' AS limits) l
  ) policy
), operational_sources AS (
  SELECT document, target_owner, document #> '{source,runtime}' AS runtime,
         (document #>> '{source,controls,text}')::jsonb AS controls,
         (document->>'createdAt')::bigint AS captured_at,
         (document->>'expiresAt')::bigint AS expires_at,
         (document #>> '{source,lossInput,maxEvidenceAgeMs}')::bigint AS age
  FROM certificate
), operational_facts AS (
  SELECT *,
         (runtime #>> '{configuration,receiptText}')::jsonb AS configuration,
         (runtime #>> '{publication,text}')::jsonb->'observation' AS observation,
         (runtime #>> '{publication,publishedAt}')::bigint AS published_at
  FROM operational_sources
), operational AS (
  SELECT (
    target_owner = runtime->'owner' AND target_owner = observation->'owner'
    AND target_owner = configuration #> '{configuration,owner}'
    AND observation->'configurationId' = configuration #> '{configuration,id}'
    AND observation->'configurationHash' = runtime #> '{configuration,hash}'
    AND runtime #>> '{configuration,hash}' =
        encode(sha256(convert_to(runtime #>> '{configuration,receiptText}', 'UTF8')), 'hex')
    AND runtime #>> '{publication,hash}' =
        encode(sha256(convert_to(runtime #>> '{publication,text}', 'UTF8')), 'hex')
    AND observation->'permissionEpoch' = runtime #> '{current,permissionEpoch}'
    AND observation->'userSessionEpoch' = runtime #> '{current,userSessionEpoch}'
    AND observation->'accountVersion' = runtime #> '{current,accountVersion}'
    AND observation->'permissionEpoch' = document #> '{source,request,authorization,permissionEpoch}'
    AND observation->'userSessionEpoch' = document #> '{source,request,authorization,userSessionEpoch}'
    AND published_at <= (runtime->>'asOf')::bigint AND (runtime->>'asOf')::bigint <= captured_at
    AND expires_at > captured_at AND age BETWEEN 1 AND 5000
    AND (observation->'health') ?& ARRAY[
      'database','limiter','authentication','publicMarket','executor','clock',
      'latency','rejectRate','maintenance'
    ]
    AND (SELECT count(*) FROM jsonb_each(observation->'health')) = 9
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(observation->'health') h
      CROSS JOIN LATERAL (SELECT (h.value->>'asOf')::bigint AS observed_at) health
      WHERE (h.value->>'status' = 'HEALTHY'
        AND observed_at >= (configuration->>'createdAt')::bigint
        AND observed_at <= published_at
        AND observed_at BETWEEN captured_at - age AND captured_at
        AND expires_at <= observed_at + age + 1) IS NOT TRUE
    )
  ) IS TRUE AS runtime_ready,
  (
    document #>> '{source,controls,hash}' =
      encode(sha256(convert_to(document #>> '{source,controls,text}', 'UTF8')), 'hex')
    AND jsonb_typeof(controls->'tenant') = 'array' AND jsonb_typeof(controls->'circuits') = 'array'
    AND jsonb_array_length(controls->'activePauses') = 0
    AND (SELECT count(*) FROM jsonb_array_elements(controls->'global') g
         WHERE g->>'kind' = 'KILL_SWITCH' AND g->>'key' = 'kill') = 1
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'global') g
         WHERE g->>'kind' = 'KILL_SWITCH' AND g->>'key' = 'kill'
           AND g #>> '{scope,kind}' = 'GLOBAL' AND g->>'state' = 'RUNNING')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'tenant') h
         WHERE h->>'kind' = 'KILL_SWITCH' AND h->>'state' IS DISTINCT FROM 'RUNNING')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements((controls->'global') || (controls->'tenant')) h
         WHERE h->>'kind' = 'CIRCUIT' AND h->>'state' IS DISTINCT FROM 'CLOSED')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(controls->'circuits') h
         WHERE h->>'state' IS DISTINCT FROM 'CLOSED')
  ) IS TRUE AS trading_ready
  FROM operational_facts
), order_facts AS (
  SELECT i.target, s.command, s.quantity, s.lot, s.tick, s.snapshot->'key' AS market_key,
         s.snapshot #> '{record,instrument}' AS instrument,
         s.snapshot #> '{record,rules}' AS rules, s.command->>'type' AS order_type,
         i.document #> '{source,capability}' AS capability,
         (i.document #>> '{source,runtime,publication,publishedAt}')::bigint AS published_at,
         (i.document->>'createdAt')::bigint AS captured_at,
         (i.document->>'expiresAt')::bigint AS expires_at
  FROM inputs i CROSS JOIN sized s
), order_checks AS (
  SELECT (
    target->'dbInstrumentId' = market_key->'dbInstrumentId'
    AND target->'dbRuleId' = market_key->'dbRuleId'
    AND command->'instrumentId' = market_key->'instrumentId'
    AND market_key->'instrumentId' = instrument->'id'
    AND instrument->'id' = rules->'instrumentId'
    AND market_key->'scope' = instrument->'scope' AND instrument->'scope' = rules->'scope'
    AND instrument #>> '{scope,market}' = 'SPOT' AND instrument->>'status' = 'TRADING'
    AND (instrument->'expiryAt' = 'null'::jsonb OR (instrument->>'expiryAt')::bigint >= expires_at)
    AND command->'ruleVersion' = rules->'version'
    AND (rules->>'effectiveAt')::bigint <= captured_at
    AND (rules->>'expiresAt')::bigint >= expires_at
    AND command #>> '{size,asset}' = instrument->>'baseAsset'
    AND command->'reduceOnly' = 'false'::jsonb AND command->'trigger' = 'null'::jsonb
    AND rules->>'quantityUnit' = 'BASE'
    AND order_type IN ('LIMIT', 'MARKET')
    AND jsonb_typeof(rules->'orderTypes') = 'array' AND (rules->'orderTypes') ? order_type
    AND jsonb_typeof(rules->'timeInForce') = 'array'
    AND (command->'timeInForce' = 'null'::jsonb OR (rules->'timeInForce') ? (command->>'timeInForce'))
    AND quantity BETWEEN (CASE order_type WHEN 'MARKET' THEN rules->>'marketMinQuantity'
                            ELSE rules->>'minQuantity' END)::numeric
                     AND (CASE order_type WHEN 'MARKET' THEN rules->>'marketMaxQuantity'
                            ELSE rules->>'maxQuantity' END)::numeric
    AND quantity > 0 AND lot > 0 AND mod(quantity, nullif(lot, 0)) = 0
    AND tick > 0
    AND CASE order_type
      WHEN 'MARKET' THEN command->'limitPrice' = 'null'::jsonb
      WHEN 'LIMIT' THEN (command->>'limitPrice')::numeric > 0
        AND mod((command->>'limitPrice')::numeric, nullif(tick, 0)) = 0
        AND (rules->'minPrice' = 'null'::jsonb OR
             (command->>'limitPrice')::numeric >= (rules->>'minPrice')::numeric)
        AND (rules->'maxPrice' = 'null'::jsonb OR
             (command->>'limitPrice')::numeric <= (rules->>'maxPrice')::numeric)
    END
  ) IS TRUE AS rules_allowed,
  (
    order_type IN ('LIMIT', 'MARKET')
    AND capability->>'adapterVersion' = 'paper-spot-l2-taker-v1'
    AND (capability->>'checkedAt')::bigint = published_at
    AND published_at <= captured_at
    AND captured_at < expires_at
    AND (capability->>'expiresAt')::bigint = expires_at
  ) IS TRUE AS capability_ready
  FROM order_facts
)
SELECT result,
       (SELECT jsonb_build_object('asset', asset, 'amount', trim_scale(amount)::text,
          'available', trim_scale(available)::text, 'remaining', trim_scale(available-amount)::text)
        FROM cash WHERE available IS NOT NULL) AS "cashProof",
       (SELECT jsonb_build_object('notional', trim_scale(notional)::text,
          'currentExposure', trim_scale(current_exposure)::text,
          'projectedExposure', trim_scale(projected_exposure)::text,
          'openOrders', open_orders, 'potentialPositions', potential_positions,
          'ordersInLastMinute', orders_in_minute, 'withinLimits', within_limits)
        FROM budget) AS "budgetProof",
       (SELECT jsonb_build_object('liquidity', trim_scale(liquidity)::text,
          'marketAllowed', market_allowed, 'lossAllowed', loss_allowed)
        FROM budget) AS "policyProof",
       (SELECT jsonb_build_object('runtimeReady', runtime_ready, 'tradingReady', trading_ready)
        FROM operational) AS "operationalProof",
       (SELECT jsonb_build_object('rulesAllowed', rules_allowed, 'capabilityReady', capability_ready)
        FROM order_checks) AS "orderProof"
FROM capture
`;
