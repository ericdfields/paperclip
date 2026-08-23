ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_status_check" CHECK ("status" IN ('queued', 'deferred_issue_execution', 'claimed', 'coalesced', 'skipped', 'completed', 'failed', 'cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_status_check" CHECK ("status" IN ('active', 'released', 'expired', 'failed', 'retained', 'pending_cleanup')) NOT VALID;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_cleanup_status_check" CHECK ("cleanup_status" IN ('pending', 'success', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "issue_tree_holds" ADD CONSTRAINT "issue_tree_holds_status_check" CHECK ("status" IN ('active', 'released')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" VALIDATE CONSTRAINT "agent_wakeup_requests_status_check";--> statement-breakpoint
ALTER TABLE "environment_leases" VALIDATE CONSTRAINT "environment_leases_status_check";--> statement-breakpoint
ALTER TABLE "environment_leases" VALIDATE CONSTRAINT "environment_leases_cleanup_status_check";--> statement-breakpoint
ALTER TABLE "issue_tree_holds" VALIDATE CONSTRAINT "issue_tree_holds_status_check";
