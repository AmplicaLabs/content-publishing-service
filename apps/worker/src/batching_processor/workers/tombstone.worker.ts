import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import { TOMBSTONE_QUEUE_NAME } from '../../../../../libs/common/src';
import { BatchingProcessorService } from '../batching.processor.service';
import { Announcement } from '../../../../../libs/common/src/interfaces/dsnp';
import { BaseConsumer } from '../../BaseConsumer';

@Injectable()
@Processor(TOMBSTONE_QUEUE_NAME, { concurrency: 2 })
export class TombstoneWorker extends BaseConsumer implements OnApplicationBootstrap {
  constructor(private batchingProcessorService: BatchingProcessorService) {
    super();
  }

  async onApplicationBootstrap() {
    return this.batchingProcessorService.setupActiveBatchTimeout(TOMBSTONE_QUEUE_NAME);
  }

  async process(job: Job<Announcement, any, string>): Promise<any> {
    return this.batchingProcessorService.process(job, TOMBSTONE_QUEUE_NAME);
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<Announcement, any, string>) {
    await this.batchingProcessorService.onCompleted(job, TOMBSTONE_QUEUE_NAME);
    // calling in the end for graceful shutdowns
    super.onCompleted(job);
  }
}
