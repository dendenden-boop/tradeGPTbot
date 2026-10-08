BEGIN;
-- Recovery work depends on the requested current instruments, never on the
-- number of immutable historical revisions. Keep every anti-reuse proof.
CREATE OR REPLACE FUNCTION ctp_registry.read_current(s jsonb,ids jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 requested text[];
 current_row record;
 history_row record;
 part text;
 ver text;
 recovered jsonb[] := ARRAY[]::jsonb[];
BEGIN
 IF NOT ctp_risk.valid_policy_publisher('ctp_instrument_registry') THEN RAISE EXCEPTION 'REGISTRY_ROLE_UNSAFE'; END IF;
 IF NOT COALESCE(ctp_registry.valid_scope(s),false) OR jsonb_typeof(ids) IS DISTINCT FROM 'array' OR jsonb_array_length(ids) NOT BETWEEN 1 AND 300
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids)v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 128 OR v#>>'{}' ~ '[[:space:][:cntrl:]]')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(ids)v)<>jsonb_array_length(ids) THEN RAISE EXCEPTION 'REGISTRY_INPUT'; END IF;
 SELECT array_agg(v) INTO requested FROM jsonb_array_elements_text(ids)v;
 -- One cursor fixes the current-record snapshot. Each historical lookup uses
 -- the entire unique key; generic cached plans cannot expand it into a scan
 -- or anti-join over the growing revision/version history.
 FOR current_row IN SELECT id,revision,record FROM ctp_registry.current_record
  WHERE scope=s AND id=ANY(requested) ORDER BY id LOOP
  SELECT h.record INTO history_row FROM ctp_registry.record_revision h
   WHERE h.scope=s AND h.id=current_row.id AND h.revision=current_row.revision;
  IF NOT FOUND OR history_row.record IS DISTINCT FROM current_row.record THEN
   RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE';
  END IF;
  FOREACH part IN ARRAY ARRAY['rules','instrument'] LOOP
   ver:=CASE WHEN part='rules' THEN current_row.record->'rules'->>'version' ELSE current_row.record->'instrument'->>'metadataVersion' END;
   SELECT h.payload,h.revision INTO history_row FROM ctp_registry.version_history h
    WHERE h.scope=s AND h.id=current_row.id AND h.kind=part AND h.version=ver;
   IF NOT FOUND OR history_row.payload IS DISTINCT FROM current_row.record->part
    OR history_row.revision>current_row.revision THEN RAISE EXCEPTION 'REGISTRY_HISTORY_INCOMPLETE'; END IF;
  END LOOP;
  recovered:=array_append(recovered,jsonb_build_object('revision',current_row.revision::text,'record',current_row.record));
 END LOOP;
 RETURN to_jsonb(recovered);
END $$;
COMMIT;
