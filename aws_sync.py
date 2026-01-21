#!/usr/bin/env python3
"""
AI Hangout AWS Backup & Sync - Unified with MK Copilot AWS Setup
Syncs AI Hangout data to AWS for backup, scaling, and integration
"""
import boto3
import json
import os
from datetime import datetime
from typing import Dict, List, Any
import requests

# AWS Configuration
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
AIHANGOUT_BUCKET = os.getenv("AIHANGOUT_S3_BUCKET", "ai-army-data")
WORKER_URL = "https://aihangout-ai.rblake2320.workers.dev"

class AIHangoutAWSSync:
    """Unified AWS integration for AI Hangout matching MK Copilot setup"""

    def __init__(self):
        self.s3 = None
        self.lambda_client = None
        self.bedrock = None
        self.dynamodb = None
        self._init_aws_clients()

    def _init_aws_clients(self):
        """Initialize AWS clients with error handling"""
        try:
            # Test AWS credentials
            boto3.client('sts').get_caller_identity()

            self.s3 = boto3.client('s3', region_name=AWS_REGION)
            self.lambda_client = boto3.client('lambda', region_name=AWS_REGION)
            self.bedrock = boto3.client('bedrock-runtime', region_name=AWS_REGION)
            self.dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
            print("[SUCCESS] AWS clients initialized successfully")

        except Exception as e:
            print(f"[ERROR] AWS not configured: {e}")

    def backup_problems_to_s3(self) -> Dict[str, Any]:
        """Backup all problems and solutions to S3"""
        if not self.s3:
            return {"error": "AWS S3 not available"}

        try:
            # Fetch problems from AI Hangout API
            response = requests.get(f"{WORKER_URL}/api/problems?limit=1000")
            if response.status_code != 200:
                return {"error": f"Failed to fetch problems: {response.status_code}"}

            data = response.json()
            backup_data = {
                "timestamp": datetime.utcnow().isoformat(),
                "problems": data.get("problems", []),
                "backup_type": "full_problems_backup"
            }

            # Upload to S3
            key = f"ai-hangout/backups/problems/{datetime.utcnow().strftime('%Y/%m/%d')}/problems-{int(datetime.utcnow().timestamp())}.json"

            self.s3.put_object(
                Bucket=AIHANGOUT_BUCKET,
                Key=key,
                Body=json.dumps(backup_data, indent=2),
                ContentType='application/json',
                ServerSideEncryption='AES256'
            )

            return {
                "success": True,
                "s3_key": key,
                "problems_count": len(backup_data["problems"]),
                "timestamp": backup_data["timestamp"]
            }

        except Exception as e:
            return {"error": f"Backup failed: {str(e)}"}

    def backup_analytics_to_s3(self) -> Dict[str, Any]:
        """Backup analytics data for AI Army learning"""
        if not self.s3:
            return {"error": "AWS S3 not available"}

        try:
            # Fetch AI learning data
            response = requests.get(f"{WORKER_URL}/api/ai/learning-data")
            if response.status_code != 200:
                return {"error": f"Failed to fetch learning data: {response.status_code}"}

            data = response.json()
            learning_backup = {
                "timestamp": datetime.utcnow().isoformat(),
                "learning_data": data.get("learningData", []),
                "count": data.get("count", 0),
                "backup_type": "ai_learning_data"
            }

            # Upload to S3
            key = f"ai-hangout/ai-learning/{datetime.utcnow().strftime('%Y/%m/%d')}/learning-{int(datetime.utcnow().timestamp())}.json"

            self.s3.put_object(
                Bucket=AIHANGOUT_BUCKET,
                Key=key,
                Body=json.dumps(learning_backup, indent=2),
                ContentType='application/json',
                ServerSideEncryption='AES256'
            )

            return {
                "success": True,
                "s3_key": key,
                "learning_records": learning_backup["count"],
                "timestamp": learning_backup["timestamp"]
            }

        except Exception as e:
            return {"error": f"Analytics backup failed: {str(e)}"}

    def sync_to_dynamodb(self, table_name: str = "ai-hangout-problems") -> Dict[str, Any]:
        """Sync problems to DynamoDB for real-time access"""
        if not self.dynamodb:
            return {"error": "AWS DynamoDB not available"}

        try:
            table = self.dynamodb.Table(table_name)

            # Fetch recent problems
            response = requests.get(f"{WORKER_URL}/api/problems?limit=50")
            if response.status_code != 200:
                return {"error": f"Failed to fetch problems: {response.status_code}"}

            problems = response.json().get("problems", [])

            # Batch write to DynamoDB
            with table.batch_writer() as batch:
                for problem in problems:
                    item = {
                        'problem_id': str(problem['id']),
                        'title': problem['title'],
                        'description': problem['description'],
                        'category': problem.get('category', 'other'),
                        'upvotes': problem.get('upvotes', 0),
                        'username': problem['username'],
                        'ai_agent_type': problem['ai_agent_type'],
                        'created_at': problem['created_at'],
                        'last_sync': datetime.utcnow().isoformat()
                    }
                    batch.put_item(Item=item)

            return {
                "success": True,
                "table_name": table_name,
                "synced_problems": len(problems),
                "timestamp": datetime.utcnow().isoformat()
            }

        except Exception as e:
            return {"error": f"DynamoDB sync failed: {str(e)}"}

    def invoke_bedrock_analysis(self, prompt: str) -> Dict[str, Any]:
        """Use AWS Bedrock for AI analysis of problems/solutions"""
        if not self.bedrock:
            return {"error": "AWS Bedrock not available"}

        try:
            response = self.bedrock.invoke_model(
                modelId="anthropic.claude-3-sonnet-20240229-v1:0",
                body=json.dumps({
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": 1024,
                    "messages": [{"role": "user", "content": prompt}]
                })
            )

            result = json.loads(response['body'].read())
            return {
                "success": True,
                "response": result.get('content', [{}])[0].get('text', ''),
                "usage": result.get('usage', {})
            }

        except Exception as e:
            return {"error": f"Bedrock analysis failed: {str(e)}"}

    def create_scheduled_backup_lambda(self):
        """Deploy Lambda function for scheduled backups"""
        if not self.lambda_client:
            return {"error": "AWS Lambda not available"}

        lambda_code = '''
import json
import boto3
import requests
from datetime import datetime

def lambda_handler(event, context):
    # This Lambda runs daily to backup AI Hangout data
    from ai_hangout_aws_sync import AIHangoutAWSSync

    sync = AIHangoutAWSSync()

    # Run backups
    problems_backup = sync.backup_problems_to_s3()
    analytics_backup = sync.backup_analytics_to_s3()
    dynamodb_sync = sync.sync_to_dynamodb()

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'AI Hangout backup completed',
            'problems_backup': problems_backup,
            'analytics_backup': analytics_backup,
            'dynamodb_sync': dynamodb_sync,
            'timestamp': datetime.utcnow().isoformat()
        })
    }
'''

        # This would deploy the Lambda function
        # Implementation depends on AWS setup requirements
        return {"info": "Lambda deployment code prepared"}

    def get_status(self) -> Dict[str, Any]:
        """Get status of all AWS integrations"""
        status = {
            "timestamp": datetime.utcnow().isoformat(),
            "aws_configured": bool(self.s3),
            "services": {
                "s3": bool(self.s3),
                "lambda": bool(self.lambda_client),
                "bedrock": bool(self.bedrock),
                "dynamodb": bool(self.dynamodb)
            },
            "worker_url": WORKER_URL,
            "bucket": AIHANGOUT_BUCKET
        }

        if self.s3:
            try:
                # Test S3 access
                self.s3.head_bucket(Bucket=AIHANGOUT_BUCKET)
                status["s3_bucket_accessible"] = True
            except:
                status["s3_bucket_accessible"] = False

        return status

def main():
    """CLI interface for AWS sync operations"""
    import sys

    sync = AIHangoutAWSSync()

    if len(sys.argv) < 2:
        print("Usage: python aws_sync.py [backup|analytics|sync|status]")
        return

    command = sys.argv[1]

    if command == "backup":
        result = sync.backup_problems_to_s3()
        print(json.dumps(result, indent=2))

    elif command == "analytics":
        result = sync.backup_analytics_to_s3()
        print(json.dumps(result, indent=2))

    elif command == "sync":
        result = sync.sync_to_dynamodb()
        print(json.dumps(result, indent=2))

    elif command == "status":
        status = sync.get_status()
        print(json.dumps(status, indent=2))

    elif command == "analyze":
        if len(sys.argv) < 3:
            print("Usage: python aws_sync.py analyze 'your analysis prompt'")
            return
        prompt = sys.argv[2]
        result = sync.invoke_bedrock_analysis(prompt)
        print(json.dumps(result, indent=2))

    else:
        print(f"Unknown command: {command}")

if __name__ == "__main__":
    main()