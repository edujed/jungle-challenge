/**
 * Health checks — liveness e readiness.
 *
 * - GET /health/live  → 200 se o processo está vivo (sem verificar deps).
 * - GET /health/ready → 200 se PostgreSQL e SQS são alcançáveis.
 *
 * Não exigem autenticação.
 */

import {
  Controller,
  Get,
  Inject,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { DATABASE, SQS_CLIENT, ENV } from "../tokens.js";
import type { Database } from "../../infrastructure/database/db.js";
import type { SqsClient } from "../../infrastructure/sqs/sqs-client.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SQS_CLIENT) private readonly sqs: SqsClient,
    @Inject(ENV) private readonly env: { sqsQueueUrl: string },
  ) {}

  @Get("live")
  live() {
    return { status: "alive" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};

    // PostgreSQL
    try {
      await this.db.em.fork().execute("SELECT 1", [], "get");
      checks.postgres = "up";
    } catch {
      checks.postgres = "down";
    }

    // SQS
    try {
      if (this.env.sqsQueueUrl) {
        const messages = await this.sqs.receiveMessages(this.env.sqsQueueUrl, 1, 0);
        void messages;
      }
      checks.sqs = "up";
    } catch {
      checks.sqs = "down";
    }

    const allUp = Object.values(checks).every((s) => s === "up");
    res.status(allUp ? 200 : 503);

    return {
      status: allUp ? "ready" : "not_ready",
      dependencies: checks,
    };
  }
}
