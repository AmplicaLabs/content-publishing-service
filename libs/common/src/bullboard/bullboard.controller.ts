import { Controller, Get, Logger } from '@nestjs/common';
import { BullBoardInstance, InjectBullBoard } from '@bull-board/nestjs';

@Controller('bull-board')
export class BullBoardController {
  logger: Logger;

  constructor(@InjectBullBoard() private readonly bullBoardInstance: BullBoardInstance) {
    this.logger = new Logger(this.constructor.name);
  }

  @Get()
  async getBullBoard() {
    return this.bullBoardInstance;
  }
}
