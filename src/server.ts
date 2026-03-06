import app from './app';
import { config } from './config';
import { connectDatabase } from './config/database';

async function startServer(): Promise<void> {
  await connectDatabase();

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
