@echo off
echo Starting AI Hangout Backup Scheduler...
echo This will run continuous backups to AWS S3 and DynamoDB
echo Press Ctrl+C to stop
echo.
cd /d "%~dp0"
python backup_scheduler.py
pause