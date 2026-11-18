import { Module, type DynamicModule } from '@nestjs/common';
import { ProcessWagerTransaction } from '../wagering/application/process-wager-transaction';
import { SqsWagerCommandHandler } from './application/sqs-wager-command-handler';
import { SqsWagerDelivery, type SqsAckClient } from './infrastructure/sqs-wager-delivery';
import { SqsWagerReceiver, type SqsReceiveClient, type SqsWagerConfiguration } from './infrastructure/sqs-wager-receiver';

@Module({})
export class MessagingModule {
  /** Composition is explicit: pass the already composed use case; no new ORM, no background consumer. */
  static register(options: { readonly processTransaction: ProcessWagerTransaction; readonly client: SqsReceiveClient & SqsAckClient; readonly configuration: SqsWagerConfiguration }): DynamicModule {
    return { module: MessagingModule, providers: [
      { provide: ProcessWagerTransaction, useValue: options.processTransaction },
      { provide: SqsWagerCommandHandler, useFactory: (process: ProcessWagerTransaction) => new SqsWagerCommandHandler(process), inject: [ProcessWagerTransaction] },
      { provide: SqsWagerReceiver, useFactory: () => new SqsWagerReceiver(options.client, options.configuration) },
      { provide: SqsWagerDelivery, useFactory: (handler: SqsWagerCommandHandler) => new SqsWagerDelivery(handler, options.client, options.configuration), inject: [SqsWagerCommandHandler] },
    ], exports: [SqsWagerCommandHandler, SqsWagerReceiver, SqsWagerDelivery] };
  }
}
