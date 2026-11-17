import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import type { FaultPoint } from './wager-process-protocol';

/** Test-only decorator. Always throws inside the real SQL callback so rollback belongs to the adapter. */
export function withWagerFault(work: WagerProcessingUnitOfWork, point: FaultPoint): WagerProcessingUnitOfWork {
  return { transaction: callback => work.transaction(async scope => {
    const result = await callback({ ...scope, insertEvents: async events => {
      if (point === 'first-event') {
        if (!events[0]) throw new Error('Fault requires an actual event');
        await scope.insertEvents([events[0]]);
        throw new Error('Injected fault: first-event');
      }
      await scope.insertEvents(events);
    } });
    if (point === 'before-commit') throw new Error('Injected fault: before-commit');
    return result;
  }) };
}
