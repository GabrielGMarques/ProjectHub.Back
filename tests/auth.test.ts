import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '../src/app';
import { User } from '../src/models/user.model';
import { config } from '../src/config';

import './setup';

describe('Auth API', () => {
  describe('GET /api/auth/profile', () => {
    it('should return user profile when authenticated', async () => {
      const user = await User.create({
        githubId: '12345',
        username: 'testuser',
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.png',
        accessToken: 'test_token',
      });

      const token = jwt.sign({ userId: user._id.toString() }, config.jwtSecret, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/profile')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('testuser');
      expect(res.body).not.toHaveProperty('accessToken');
    });

    it('should reject without token', async () => {
      const res = await request(app).get('/api/auth/profile');
      expect(res.status).toBe(401);
    });

    it('should reject with invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/profile')
        .set('Authorization', 'Bearer invalid_token');
      expect(res.status).toBe(401);
    });
  });
});
