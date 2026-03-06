import { body, ValidationChain } from 'express-validator';

export const validateProject: ValidationChain[] = [
  body('name')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Name must be between 1 and 200 characters'),
  body('description')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Description must be at most 2000 characters'),
  body('backgroundImage')
    .optional()
    .isString()
    .withMessage('Background image must be a string URL'),
  body('githubRepos')
    .optional()
    .isArray()
    .withMessage('GitHub repos must be an array'),
  body('githubRepos.*')
    .optional()
    .isString()
    .withMessage('Each GitHub repo must be a string'),
  body('mrr')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('MRR must be a non-negative number'),
  body('clientCount')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Client count must be a non-negative integer'),
  body('impact')
    .optional()
    .isIn(['low', 'medium', 'high'])
    .withMessage('Impact must be low, medium, or high'),
  body('niche')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Niche must be at most 200 characters'),
  body('timeConsumption')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Time consumption must be a non-negative number'),
];

export const validateCreateProject: ValidationChain[] = [
  body('name')
    .notEmpty()
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Name is required and must be between 1 and 200 characters'),
  ...validateProject.filter(v => (v as any).builder?.fields?.[0] !== 'name'),
];
