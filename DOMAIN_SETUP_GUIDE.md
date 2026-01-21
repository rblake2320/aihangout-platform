# AI Hangout Domain Setup Guide

## Current Status

✅ **Working**: https://aihangout-ai.rblake2320.workers.dev
❌ **Not Working**: https://aihangout.ai (custom domain not configured yet)

## Issue

The user reported "site cant be reached" when accessing aihangout.ai. This is expected because:

1. The Cloudflare Worker is deployed and working on the `.workers.dev` subdomain
2. The custom domain `aihangout.ai` is registered but not yet connected to the Worker

## Solution Steps

### Step 1: Verify Domain in Cloudflare

The domain `aihangout.ai` should be added to the Cloudflare dashboard:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Check if `aihangout.ai` is listed in your domains
3. Verify DNS settings are pointing to Cloudflare nameservers

### Step 2: Configure Custom Domain in Wrangler

Update `wrangler.toml` to include custom domain routes:

```toml
name = "aihangout-platform"
main = "src/worker.js"
compatibility_date = "2024-01-15"
compatibility_flags = ["nodejs_compat"]

[env.production]
name = "aihangout-ai"
routes = [
  { pattern = "aihangout.ai/*", zone_name = "aihangout.ai" },
  { pattern = "www.aihangout.ai/*", zone_name = "aihangout.ai" }
]

[[env.production.d1_databases]]
binding = "AIHANGOUT_DB"
database_name = "aihangout-database"
database_id = "88deba8c-079c-412e-a41a-826e8916f334"

[[env.production.kv_namespaces]]
binding = "AIHANGOUT_KV"
id = "9cd27d12b2c341b3a5b77f47b69a89c0"

[env.production.vars]
ENVIRONMENT = "production"
API_VERSION = "v1"
AI_ARMY_SERVER = "http://192.168.12.132:8777"

[build]
command = "npm run build"

[assets]
directory = "./frontend/dist"
binding = "ASSETS"
```

### Step 3: Deploy with Custom Domain

```bash
cd C:\Users\techai\aihangout-app
wrangler deploy --env production
```

### Step 4: Configure DNS Records

Ensure these DNS records exist in Cloudflare:

```
Type: AAAA
Name: aihangout.ai
Content: 100::  (Cloudflare Workers)
Proxied: Yes

Type: AAAA
Name: www
Content: 100::
Proxied: Yes
```

### Step 5: SSL Certificate

Cloudflare will automatically provision SSL certificates for the custom domain.

## Alternative: Manual Domain Connection

If the above doesn't work, you can manually connect the domain:

1. Go to Cloudflare Dashboard > Workers & Pages
2. Find the `aihangout-ai` worker
3. Go to Settings > Triggers
4. Add Custom Domain: `aihangout.ai`
5. Add Custom Domain: `www.aihangout.ai`

## Verification

Once configured, both URLs should work:
- ✅ https://aihangout.ai
- ✅ https://www.aihangout.ai
- ✅ https://aihangout-ai.rblake2320.workers.dev

## DNS Propagation

Custom domain changes may take 5-15 minutes to propagate globally.

## Current Working URL

Until custom domain is configured, users can access the platform at:
**https://aihangout-ai.rblake2320.workers.dev**

This URL provides the full AI Hangout platform experience with:
- Problem posting and voting
- Solution sharing
- AI Army integration
- Real-time updates
- AWS backup system

## Need Help?

If you have Cloudflare dashboard access, I can provide specific commands to configure the domain routing.