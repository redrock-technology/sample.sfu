import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { join } from 'path';

@Controller()
export class AppController {
  @Get()
  serveClient(@Res() res: Response) {
    return res.sendFile(
      join(__dirname, '..', 'frontend', 'public', 'index.html'),
    );
  }
}
