// Isolated test sender only. Bypass the runner's trailing throttle for the one
// genuinely completed witness; never invent or relabel a native task result.
export function createNativeProgressPublisher(send) {
  let sent = false;
  return async (task) => {
    if (
      sent ||
      task.name !== 'completed native owner progress witness' ||
      task.result?.state !== 'pass'
    )
      return;
    sent = true;
    await send([[task.id, { ...task.result }, task.meta]], [[task.id, 'test-finished', undefined]]);
  };
}
