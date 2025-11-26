import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Enable CORS
  app.enableCors();
  
  // Serve static files from frontend/public
  app.useStaticAssets(join(__dirname, '..', 'frontend', 'public'));
  
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || 'localhost';
  
  await app.listen(port);
  console.log(`Server running on http://${host}:${port}`);
}
bootstrap();
