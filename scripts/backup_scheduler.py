#!/usr/bin/env python3
"""
AI Hangout Backup Scheduler - Automated AWS Backup System
Matches MK Copilot backup infrastructure for unified AI Army data management
"""
import schedule
import time
import json
import logging
from datetime import datetime
from aws_sync import AIHangoutAWSSync

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('backup_scheduler.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def run_full_backup():
    """Run complete backup of AI Hangout data to AWS"""
    logger.info("Starting scheduled AI Hangout backup...")

    sync = AIHangoutAWSSync()

    # 1. Backup problems and solutions
    logger.info("Backing up problems to S3...")
    problems_result = sync.backup_problems_to_s3()

    # 2. Backup analytics and learning data
    logger.info("Backing up analytics to S3...")
    analytics_result = sync.backup_analytics_to_s3()

    # 3. Sync to DynamoDB for real-time access
    logger.info("Syncing to DynamoDB...")
    dynamodb_result = sync.sync_to_dynamodb()

    # Log results
    backup_summary = {
        "timestamp": datetime.now().isoformat(),
        "problems_backup": problems_result,
        "analytics_backup": analytics_result,
        "dynamodb_sync": dynamodb_result
    }

    logger.info(f"Backup completed: {json.dumps(backup_summary, indent=2)}")

    # Save backup summary
    with open(f"backup_summary_{int(datetime.now().timestamp())}.json", "w") as f:
        json.dump(backup_summary, f, indent=2)

    return backup_summary

def run_quick_sync():
    """Quick DynamoDB sync for real-time updates"""
    logger.info("Running quick DynamoDB sync...")

    sync = AIHangoutAWSSync()
    result = sync.sync_to_dynamodb()

    logger.info(f"Quick sync completed: {json.dumps(result, indent=2)}")
    return result

def main():
    """Main scheduler loop"""
    logger.info("AI Hangout Backup Scheduler started")
    logger.info("Backup schedule:")
    logger.info("  - Full backup (S3 + DynamoDB): Every 6 hours")
    logger.info("  - Quick sync (DynamoDB only): Every 30 minutes")

    # Schedule full backups every 6 hours
    schedule.every(6).hours.do(run_full_backup)

    # Schedule quick syncs every 30 minutes
    schedule.every(30).minutes.do(run_quick_sync)

    # Run initial backup
    logger.info("Running initial backup...")
    run_full_backup()

    # Keep scheduler running
    logger.info("Scheduler is running. Press Ctrl+C to stop.")
    try:
        while True:
            schedule.run_pending()
            time.sleep(60)  # Check every minute
    except KeyboardInterrupt:
        logger.info("Backup scheduler stopped by user")
    except Exception as e:
        logger.error(f"Scheduler error: {e}")
        raise

if __name__ == "__main__":
    main()