import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { GitHubService } from '../services/github.service';

const githubService = new GitHubService();

export class GitHubController {
  async getRepos(req: AuthRequest, res: Response): Promise<void> {
    try {
      const repos = await githubService.getUserRepos(req.userId!);
      res.json(repos);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch repositories' });
    }
  }

  async getRepoDetails(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { owner, repo } = req.params;
      const details = await githubService.getRepoDetails(req.userId!, owner, repo);
      res.json(details);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch repository details' });
    }
  }
}
