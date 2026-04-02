import { BruceTodo, IBruceTodo } from '../models/bruce-todo.model';

export class BruceTodoService {
  async list(userId: string) {
    return BruceTodo.find({ userId }).sort({ done: 1, priority: -1, createdAt: -1 }).lean();
  }

  async pending(userId: string) {
    return BruceTodo.find({ userId, done: false }).sort({ priority: -1, createdAt: -1 }).lean();
  }

  async add(userId: string, text: string, priority: 'low' | 'normal' | 'high' = 'normal', category?: string) {
    return BruceTodo.create({ userId, text, priority, category });
  }

  async addMany(userId: string, items: { text: string; priority?: string; category?: string }[]) {
    const docs = items.map(i => ({
      userId,
      text: i.text,
      priority: i.priority || 'normal',
      category: i.category,
    }));
    return BruceTodo.insertMany(docs) as any;
  }

  async toggleDone(userId: string, todoId: string) {
    const todo = await BruceTodo.findOne({ _id: todoId, userId });
    if (!todo) return null;
    todo.done = !todo.done;
    await todo.save();
    return todo;
  }

  async markDone(userId: string, todoId: string) {
    return BruceTodo.findOneAndUpdate({ _id: todoId, userId }, { done: true }, { new: true });
  }

  async markDoneByText(userId: string, text: string) {
    return BruceTodo.findOneAndUpdate(
      { userId, text: { $regex: new RegExp(`^${escapeRegex(text)}$`, 'i') } },
      { done: true },
      { new: true },
    );
  }

  async remove(userId: string, todoId: string): Promise<boolean> {
    const result = await BruceTodo.deleteOne({ _id: todoId, userId });
    return result.deletedCount > 0;
  }

  async removeByText(userId: string, text: string): Promise<boolean> {
    const result = await BruceTodo.deleteOne({
      userId,
      text: { $regex: new RegExp(`^${escapeRegex(text)}$`, 'i') },
    });
    return result.deletedCount > 0;
  }

  async clearDone(userId: string): Promise<number> {
    const result = await BruceTodo.deleteMany({ userId, done: true });
    return result.deletedCount;
  }

  async update(userId: string, todoId: string, updates: Partial<Pick<IBruceTodo, 'text' | 'priority' | 'category'>>) {
    return BruceTodo.findOneAndUpdate({ _id: todoId, userId }, updates, { new: true });
  }

  /** Summary string for Alfred's context */
  async summaryForContext(userId: string): Promise<string> {
    const todos = await this.pending(userId);
    if (!todos.length) return '';
    const priorityIcon = (p: string) => p === 'high' ? '🔴' : p === 'low' ? '⚪' : '🟡';
    const lines = todos.map(t => `  ${priorityIcon(t.priority)} ${t.text}${t.category ? ` [${t.category}]` : ''}`);
    return `\n=== 📋 BRUCE'S TODOS (${todos.length} pending) ===\n${lines.join('\n')}\n`;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const bruceTodoService = new BruceTodoService();
