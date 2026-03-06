import { Project, IProject } from '../models/project.model';
import { Types } from 'mongoose';

export class ProjectService {
  async findAllByUser(userId: string): Promise<IProject[]> {
    return Project.find({ userId: new Types.ObjectId(userId) }).sort({ updatedAt: -1 });
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
    return Project.findOneAndUpdate(
      { _id: id, userId: new Types.ObjectId(userId) },
      { $set: data },
      { new: true, runValidators: true }
    );
  }

  async delete(id: string, userId: string): Promise<IProject | null> {
    return Project.findOneAndDelete({ _id: id, userId: new Types.ObjectId(userId) });
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
