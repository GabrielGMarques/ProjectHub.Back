import { User } from '../models/user.model';

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  updated_at: string;
}

export class GitHubService {
  private readonly apiBase = 'https://api.github.com';

  async getUserRepos(userId: string): Promise<GitHubRepo[]> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const response = await fetch(`${this.apiBase}/user/repos?sort=updated&per_page=100`, {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json() as Promise<GitHubRepo[]>;
  }

  async getRepoDetails(userId: string, owner: string, repo: string): Promise<GitHubRepo> {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const response = await fetch(`${this.apiBase}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json() as Promise<GitHubRepo>;
  }
}
