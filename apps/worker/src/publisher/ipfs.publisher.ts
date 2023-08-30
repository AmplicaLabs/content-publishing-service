import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KeyringPair } from '@polkadot/keyring/types';
import { ISubmittableResult } from '@polkadot/types/types';
import { SubmittableExtrinsic } from '@polkadot/api-base/types';
import { InjectQueue } from '@nestjs/bullmq';
import { Hash } from '@polkadot/types/interfaces';
import { BlockchainService } from '../blockchain/blockchain.service';
import { ConfigService } from '../../../api/src/config/config.service';
import { IPublisherJob } from '../interfaces/publisher-job.interface';
import { createKeys } from '../blockchain/create-keys';
import { IStatusMonitorJob } from '../interfaces/status-monitor.interface';
import { QueueConstants } from '../../../../libs/common/src';

@Injectable()
export class IPFSPublisher {
  private logger: Logger;

  constructor(
    @InjectQueue(QueueConstants.TRANSACTION_RECEIPT_QUEUE_NAME) private txReceiptQueue,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private eventEmitter: EventEmitter2,
  ) {
    this.logger = new Logger(IPFSPublisher.name);
  }

  public async publish(message: IPublisherJob): Promise<{ [key: string]: bigint }> {
    const providerKeys = createKeys(this.configService.getProviderAccountSeedPhrase());

    const batch: SubmittableExtrinsic<'rxjs', ISubmittableResult>[] = [];
    const tx = this.blockchainService.createExtrinsicCall({ pallet: 'messages', extrinsic: 'addIpfsMessage' }, message.schemaId, message.data.cid, message.data.payloadLength);
    return this.processSingleBatch(message.id, providerKeys, tx);
  }

  async processSingleBatch(jobId: string, providerKeys: KeyringPair, tx: SubmittableExtrinsic<'rxjs', ISubmittableResult>): Promise<{ [key: string]: bigint }> {
    this.logger.debug(`Submitting tx of size ${tx.length}`);
    try {
      const currrentEpoch = await this.blockchainService.getCurrentCapacityEpoch();
      const [txHash, eventMap] = await this.blockchainService
        .createExtrinsic({ pallet: 'frequencyTxPayment', extrinsic: 'payWithCapacity' }, { eventPallet: 'messages', event: 'MessagesStored' }, providerKeys, [tx])
        .signAndSend();
      const capacityWithDrawn = BigInt(eventMap['capacity.CapacityWithdrawn'].data[1].toString());

      this.sendJobToTxReceiptQueue(jobId, txHash);
      this.logger.debug(`Batch processed, capacity withdrawn: ${capacityWithDrawn}`);
      return { [currrentEpoch.toString()]: capacityWithDrawn };
    } catch (e) {
      this.logger.error(`Error processing batch: ${e}`);
      throw e;
    }
  }

  async sendJobToTxReceiptQueue(jobId: any, txHash: Hash): Promise<void> {
    const job: IStatusMonitorJob = {
      id: txHash.toString(),
      txHash: txHash.toString(),
      publisherJobId: jobId,
    };
    await this.txReceiptQueue.add(txHash.toString(), job, { removeOnComplete: true, removeOnFail: true });
  }
}
