import { z } from "zod";
import { PRIORITIES, TYPES } from "../types";

const instant = z
  .string()
  .refine(
    (value) =>
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Expected an ISO date with timezone offset",
  );
export const ParsedCommitmentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(),
  project: z.string().max(200).nullable(),
  commitmentType: z.enum(TYPES),
  contactName: z.string().max(200).nullable(),
  organization: z.string().max(200).nullable(),
  deadline: instant.nullable(),
  checkInAt: instant.nullable(),
  estimatedMinutes: z.number().int().min(1).max(525600).nullable(),
  priority: z.enum(PRIORITIES),
  nextAction: z.string().max(1000).nullable(),
  confidence: z.number().min(0).max(1),
  inferredFields: z.array(z.string().max(100)).max(30).default([]),
  warnings: z.array(z.string().max(500)).max(30).default([]),
});
