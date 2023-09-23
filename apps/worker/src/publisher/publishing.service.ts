import { InjectRedis } from '@liaoliaots/nestjs-redis';
import { Processor, WorkerHost, OnWorkerEvent, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { MILLISECONDS_PER_SECOND } from 'time-constants';
import { Hash } from '@polkadot/types/interfaces';
import { BlockchainService } from '../../../../libs/common/src/blockchain/blockchain.service';
import { ConfigService } from '../../../../libs/common/src/config/config.service';
import { IPublisherJob } from '../interfaces/publisher-job.interface';
import { IPFSPublisher } from './ipfs.publisher';
import { CAPACITY_EPOCH_TIMEOUT_NAME, SECONDS_PER_BLOCK } from '../../../../libs/common/src/constants';
import { QueueConstants } from '../../../../libs/common/src';
import { ITxMonitorJob } from '../interfaces/status-monitor.interface';

@Injectable()
@Processor(QueueConstants.PUBLISH_QUEUE_NAME, {
  concurrency: 2,
})
export class PublishingService extends WorkerHost implements OnApplicationBootstrap, OnModuleDestroy {
  private logger: Logger;

  private capacityExhausted = false;

  constructor(
    @InjectRedis() private cacheManager: Redis,
    @InjectQueue(QueueConstants.TRANSACTION_RECEIPT_QUEUE_NAME) private txReceiptQueue,
    @InjectQueue(QueueConstants.PUBLISH_QUEUE_NAME) private publishQueue: Queue,
    private blockchainService: BlockchainService,
    private configService: ConfigService,
    private ipfsPublisher: IPFSPublisher,
    private schedulerRegistry: SchedulerRegistry,
    private eventEmitter: EventEmitter2,
  ) {
    super();
    this.logger = new Logger(this.constructor.name);
  }

  public async onApplicationBootstrap() {
    await this.checkCapacity();
  }

  public onModuleDestroy() {
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (e) {
      // 💀 //
    }
  }

  async process(job: Job<IPublisherJob, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    try {
      const currentBlockNumber = await this.blockchainService.getLatestFinalizedBlockHash();
      const txHash = await this.ipfsPublisher.publish(job.data);
      this.logger.verbose(`Successfully completed job ${job.id}`);
      return { success: true };
    } catch (e) {
      this.logger.error(`Job ${job.id} failed (attempts=${job.attemptsMade})`);
      if (e instanceof Error && e.message.includes('Inability to pay some fees')) {
        this.eventEmitter.emit('capacity.exhausted');
        // TODO: revisit this logic
      }
      throw e;
    } finally {
      await this.checkCapacity();
    }
  }

  async sendJobToTxReceiptQueue(jobId: any, txHash: Hash, lastBlockNumber: bigint): Promise<void> {
    const job: ITxMonitorJob = {
      id: txHash.toString(),
      lastFinalizedBlockNumber: lastBlockNumber,
      txHash,
      publisherJobId: jobId,
    };
    await this.txReceiptQueue.add(txHash.toString(), job, { removeOnComplete: true, removeOnFail: true });
  }

  private async checkCapacity(): Promise<void> {
    const capacityLimit = this.configService.getCapacityLimit();
    const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());
    const { remainingCapacity } = capacity;
    const { currentEpoch } = capacity;
    const epochCapacityKey = `epochCapacity:${currentEpoch}`;
    const epochUsedCapacity = BigInt((await this.cacheManager.get(epochCapacityKey)) ?? 0); // Fetch capacity used by the service
    let outOfCapacity = remainingCapacity <= 0n;

    if (!outOfCapacity) {
      this.logger.debug(`Capacity remaining: ${remainingCapacity}`);
      if (capacityLimit.type === 'percentage') {
        const capacityLimitPercentage = BigInt(capacityLimit.value);
        const capacityLimitThreshold = (capacity.totalCapacityIssued * capacityLimitPercentage) / 100n;
        this.logger.debug(`Capacity limit threshold: ${capacityLimitThreshold}`);
        if (epochUsedCapacity >= capacityLimitThreshold) {
          outOfCapacity = true;
          this.logger.warn(`Capacity threshold reached: used ${epochUsedCapacity} of ${capacityLimitThreshold}`);
        }
      } else if (epochUsedCapacity >= capacityLimit.value) {
        outOfCapacity = true;
        this.logger.warn(`Capacity threshold reached: used ${epochUsedCapacity} of ${capacityLimit.value}`);
      }
    }

    if (outOfCapacity) {
      await this.eventEmitter.emitAsync('capacity.exhausted');
    } else {
      await this.eventEmitter.emitAsync('capacity.refilled');
    }
  }

  @OnEvent('capacity.exhausted', { async: true, promisify: true })
  private async handleCapacityExhausted() {
    this.logger.debug('Received capacity.exhausted event');
    this.capacityExhausted = true;
    await this.publishQueue.pause();
    const capacityLimit = this.configService.getCapacityLimit();
    const capacity = await this.blockchainService.capacityInfo(this.configService.getProviderId());

    this.logger.debug(`
    Capacity limit: ${JSON.stringify(capacityLimit)}
    Remaining Capacity: ${JSON.stringify(capacity.remainingCapacity.toString())})}`);

    const blocksRemaining = capacity.nextEpochStart - capacity.currentBlockNumber;
    try {
      this.schedulerRegistry.addTimeout(
        CAPACITY_EPOCH_TIMEOUT_NAME,
        setTimeout(() => this.checkCapacity(), blocksRemaining * SECONDS_PER_BLOCK * MILLISECONDS_PER_SECOND),
      );
    } catch (err) {
      // ignore duplicate timeout
    }
  }

  @OnEvent('capacity.refilled', { async: true, promisify: true })
  private async handleCapacityRefilled() {
    this.logger.debug('Received capacity.refilled event');
    this.capacityExhausted = false;
    try {
      this.schedulerRegistry.deleteTimeout(CAPACITY_EPOCH_TIMEOUT_NAME);
    } catch (err) {
      // ignore
    }
  }

  // eslint-disable-next-line class-methods-use-this
  @OnWorkerEvent('completed')
  onCompleted() {
    // do some stuff
  }
}
