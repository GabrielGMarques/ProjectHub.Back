import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../src/app';
import { Project } from '../src/models/project.model';
import { config } from '../src/config';

import './setup';

function generateToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '1h' });
}

describe('Analytics API', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  let token: string;

  beforeEach(() => {
    token = generateToken(userId);
  });

  describe('GET /api/analytics/time-allocation', () => {
    it('should return time allocation data', async () => {
      await Project.create([
        { userId, name: 'Project A', timeConsumption: 20 },
        { userId, name: 'Project B', timeConsumption: 15 },
      ]);

      const res = await request(app)
        .get('/api/analytics/time-allocation')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toHaveProperty('name');
      expect(res.body[0]).toHaveProperty('timeConsumption');
    });

    it('should return empty array when no projects', async () => {
      const res = await request(app)
        .get('/api/analytics/time-allocation')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });
});
