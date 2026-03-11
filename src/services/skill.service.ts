import { Skill, ISkill, BUILT_IN_SKILLS } from '../models/skill.model';

export class SkillService {
  async findAllForUser(userId: string, projectId?: string): Promise<ISkill[]> {
    const query: any = {
      $or: [
        { userId, projectId: null },
        { isBuiltIn: true },
      ],
    };
    if (projectId) {
      query.$or.push({ userId, projectId });
    }
    return Skill.find(query).sort({ isBuiltIn: -1, category: 1, name: 1 });
  }

  async findById(id: string, userId: string): Promise<ISkill | null> {
    return Skill.findOne({ _id: id, $or: [{ userId }, { isBuiltIn: true }] });
  }

  async create(userId: string, data: Partial<ISkill>): Promise<ISkill> {
    return Skill.create({ ...data, userId, isBuiltIn: false });
  }

  async update(id: string, userId: string, data: Partial<ISkill>): Promise<ISkill | null> {
    return Skill.findOneAndUpdate(
      { _id: id, userId, isBuiltIn: false },
      data,
      { new: true }
    );
  }

  async delete(id: string, userId: string): Promise<ISkill | null> {
    return Skill.findOneAndDelete({ _id: id, userId, isBuiltIn: false });
  }

  async seedBuiltInSkills(userId: string): Promise<void> {
    for (const skill of BUILT_IN_SKILLS) {
      const exists = await Skill.findOne({ name: skill.name, userId, isBuiltIn: true });
      if (!exists) {
        await Skill.create({ ...skill, userId, isBuiltIn: true });
      }
    }
  }
}
