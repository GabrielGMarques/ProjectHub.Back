import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/user.model';
import { config } from '../config';

export class AuthService {
  generateToken(userId: string): string {
    return jwt.sign({ userId }, config.jwtSecret, { expiresIn: '7d' });
  }

  async findOrCreateUser(profile: {
    githubId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    accessToken: string;
  }): Promise<IUser> {
    let user = await User.findOne({ githubId: profile.githubId });

    if (user) {
      user.accessToken = profile.accessToken;
      user.username = profile.username;
      user.displayName = profile.displayName;
      user.avatarUrl = profile.avatarUrl;
      await user.save();
    } else {
      user = await User.create(profile);
    }

    return user;
  }

  async findUserById(id: string): Promise<IUser | null> {
    return User.findById(id).select('-accessToken');
  }
}
