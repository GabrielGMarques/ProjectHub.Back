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
  body('timeSpent')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Time spent must be a non-negative number'),
  body('todos')
    .optional()
    .isArray()
    .withMessage('Todos must be an array'),
  body('todos.*.text')
    .optional()
    .isString()
    .withMessage('Todo text must be a string'),
  body('todos.*.done')
    .optional()
    .isBoolean()
    .withMessage('Todo done must be a boolean'),
  body('todos.*.children')
    .optional()
    .isArray()
    .withMessage('Todo children must be an array'),
  body('monetizationPlan')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 5000 })
    .withMessage('Monetization plan must be at most 5000 characters'),
  body('schedule')
    .optional()
    .isObject()
    .withMessage('Schedule must be an object'),
  body('schedule.monday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.tuesday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.wednesday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.thursday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.friday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.saturday').optional().isFloat({ min: 0, max: 24 }),
  body('schedule.sunday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay')
    .optional()
    .isObject()
    .withMessage('Time spent per day must be an object'),
  body('timeSpentPerDay.monday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.tuesday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.wednesday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.thursday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.friday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.saturday').optional().isFloat({ min: 0, max: 24 }),
  body('timeSpentPerDay.sunday').optional().isFloat({ min: 0, max: 24 }),
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
