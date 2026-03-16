import { Project, IProject, IDocument } from '../models/project.model';
import { Types } from 'mongoose';
import fs from 'fs';
import path from 'path';

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

export class ProjectService {
  async findAllByUser(userId: string): Promise<IProject[]> {
    return Project.find({ userId: new Types.ObjectId(userId) }).sort({ sortOrder: 1, createdAt: -1 });
  }

  async findById(id: string, userId: string): Promise<IProject | null> {
    return Project.findOne({ _id: id, userId: new Types.ObjectId(userId) });
  }

  async create(userId: string, data: Partial<IProject>): Promise<IProject> {
    const project = new Project({
      ...data,
      userId: new Types.ObjectId(userId),
    });
    return project.save();
  }

  async update(id: string, userId: string, data: Partial<IProject>): Promise<IProject | null> {
    if (data.schedule) {
      const s = data.schedule;
      data.timeConsumption = (s.monday || 0) + (s.tuesday || 0) + (s.wednesday || 0)
        + (s.thursday || 0) + (s.friday || 0) + (s.saturday || 0) + (s.sunday || 0);
    }
    if (data.timeSpentPerDay) {
      const s = data.timeSpentPerDay;
      data.timeSpent = (s.monday || 0) + (s.tuesday || 0) + (s.wednesday || 0)
        + (s.thursday || 0) + (s.friday || 0) + (s.saturday || 0) + (s.sunday || 0);
    }
    return Project.findOneAndUpdate(
      { _id: id, userId: new Types.ObjectId(userId) },
      { $set: data },
      { new: true, runValidators: true }
    );
  }

  async delete(id: string, userId: string): Promise<IProject | null> {
    return Project.findOneAndDelete({ _id: id, userId: new Types.ObjectId(userId) });
  }

  async reorder(userId: string, projectIds: string[], field: 'sortOrder' | 'burndownSortOrder' = 'sortOrder'): Promise<void> {
    const ops = projectIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, userId: new Types.ObjectId(userId) },
        update: { $set: { [field]: index } },
      },
    }));
    await Project.bulkWrite(ops);
  }

  async addDocument(projectId: string, userId: string, doc: IDocument): Promise<IProject | null> {
    return Project.findOneAndUpdate(
      { _id: projectId, userId: new Types.ObjectId(userId) },
      { $push: { documents: doc } },
      { new: true }
    );
  }

  async removeDocument(projectId: string, userId: string, docId: string): Promise<IProject | null> {
    const project = await Project.findOne({ _id: projectId, userId: new Types.ObjectId(userId) });
    if (!project) return null;
    const doc = (project.documents as any)?.id(docId);
    if (doc) {
      const filePath = path.join(UPLOADS_DIR, doc.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      (project.documents as any).pull(docId);
      await project.save();
    }
    return project;
  }

  async getTimeAllocation(userId: string): Promise<{ projectId: string; name: string; timeConsumption: number }[]> {
    const projects = await Project.find(
      { userId: new Types.ObjectId(userId) },
      { name: 1, timeConsumption: 1 }
    );
    return projects.map((p) => ({
      projectId: p._id.toString(),
      name: p.name,
      timeConsumption: p.timeConsumption,
    }));
  }
}
