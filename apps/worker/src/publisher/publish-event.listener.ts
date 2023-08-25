import { QueueEventsListener, QueueEventsHost, OnQueueEvent } from '@nestjs/bullmq';

@QueueEventsListener('publishQueue')
export class PublishEventListener extends QueueEventsHost {
  startTime: number;

  constructor() {
    super();
    this.startTime = new Date().getTime();
  }

  @OnQueueEvent('drained')
  onDrained({ jobId }: { jobId: string }) {
    // do some stuff

    const elapsed = new Date().getTime();
    console.log((elapsed - this.startTime) / 1000);
  }
}
