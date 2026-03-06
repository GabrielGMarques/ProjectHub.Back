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

describe('Project API', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  let token: string;

  beforeEach(() => {
    token = generateToken(userId);
  });

  describe('POST /api/projects', () => {
    it('should create a new project', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Test Project',
          description: 'A test project',
          mrr: 100,
          clientCount: 5,
          impact: 'medium',
          niche: 'SaaS',
          timeConsumption: 10,
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Project');
      expect(res.body.mrr).toBe(100);
      expect(res.body.impact).toBe('medium');
    });

    it('should require a name', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'No name project' });

      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'Test' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/projects', () => {
    it('should return all projects for user', async () => {
      await Project.create([
        { userId, name: 'Project 1', description: 'First' },
        { userId, name: 'Project 2', description: 'Second' },
      ]);

      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should not return other users projects', async () => {
      const otherUserId = new mongoose.Types.ObjectId();
      await Project.create({ userId: otherUserId, name: 'Other Project' });

      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('should return a single project', async () => {
      const project = await Project.create({ userId, name: 'My Project', mrr: 50 });

      const res = await request(app)
        .get(`/api/projects/${project._id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('My Project');
    });

    it('should return 404 for non-existent project', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/projects/${fakeId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/projects/:id', () => {
    it('should update a project', async () => {
      const project = await Project.create({ userId, name: 'Old Name' });

      const res = await request(app)
        .put(`/api/projects/${project._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Name', mrr: 200 });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
      expect(res.body.mrr).toBe(200);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('should partially update a project', async () => {
      const project = await Project.create({ userId, name: 'Proj', mrr: 100 });

      const res = await request(app)
        .patch(`/api/projects/${project._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ mrr: 300 });

      expect(res.status).toBe(200);
      expect(res.body.mrr).toBe(300);
      expect(res.body.name).toBe('Proj');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('should delete a project', async () => {
      const project = await Project.create({ userId, name: 'To Delete' });

      const res = await request(app)
        .delete(`/api/projects/${project._id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);

      const found = await Project.findById(project._id);
      expect(found).toBeNull();
    });
  });
});

describe('Health Check', () => {
  it('should return ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
