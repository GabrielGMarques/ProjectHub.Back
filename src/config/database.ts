import mongoose from 'mongoose';
import { config } from './index';

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongodbUri);
    console.log('Connected to MongoDB');

    // Migrate TTL indexes if they changed (e.g., employee logs 24h -> 7 weeks)
    try {
      const db = mongoose.connection.db;
      if (db) {
        const collections = await db.listCollections({ name: 'employeelogs' }).toArray();
        if (collections.length > 0) {
          const indexes = await db.collection('employeelogs').indexes();
          const ttlIndex = indexes.find((i: any) => i.key?.createdAt === 1 && i.expireAfterSeconds != null);
          if (ttlIndex && ttlIndex.expireAfterSeconds !== 4233600) {
            console.log(`Migrating EmployeeLog TTL: ${ttlIndex.expireAfterSeconds}s -> 4233600s (7 weeks)`);
            await db.collection('employeelogs').dropIndex(ttlIndex.name!);
          }
        }
      }
    } catch { /* index migration is best-effort */ }
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
