import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { bruceTodoService } from '../services/bruce-todo.service';

export class BruceTodoController {
  async list(req: AuthRequest, res: Response) {
    try {
      const todos = await bruceTodoService.list(req.userId!);
      res.json(todos);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async add(req: AuthRequest, res: Response) {
    try {
      const { text, priority, category } = req.body;
      if (!text) return res.status(400).json({ error: 'text is required' });
      const todo = await bruceTodoService.add(req.userId!, text, priority, category);
      res.status(201).json(todo);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async addMany(req: AuthRequest, res: Response) {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array is required' });
      const todos = await bruceTodoService.addMany(req.userId!, items);
      res.status(201).json(todos);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async toggle(req: AuthRequest, res: Response) {
    try {
      const todo = await bruceTodoService.toggleDone(req.userId!, req.params.id);
      if (!todo) return res.status(404).json({ error: 'Todo not found' });
      res.json(todo);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async update(req: AuthRequest, res: Response) {
    try {
      const { text, priority, category } = req.body;
      const todo = await bruceTodoService.update(req.userId!, req.params.id, { text, priority, category });
      if (!todo) return res.status(404).json({ error: 'Todo not found' });
      res.json(todo);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async remove(req: AuthRequest, res: Response) {
    try {
      const ok = await bruceTodoService.remove(req.userId!, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Todo not found' });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  async clearDone(req: AuthRequest, res: Response) {
    try {
      const count = await bruceTodoService.clearDone(req.userId!);
      res.json({ cleared: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
