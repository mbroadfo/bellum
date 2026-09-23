# bootstrap.ps1 - One-time OIDC setup for a new spa-on-aws project. Idempotent.
#
# v2: GitHub Actions OIDC federation replaces long-lived IAM user keys.
# Workflows assume short-lived roles; NO AWS credentials are stored in
# GitHub Secrets, so there is nothing to rotate or leak.
#
# Creates:
#   1. S3 bucket for Terraform state      ({app}-tf-state)
#   2. GitHub OIDC identity provider      (token.actions.githubusercontent.com, if absent)
#   3. IAM role {app}-terraform           (scoped to this stack - not AdministratorAccess)
#   4. IAM role {app}-ci                  (assets sync, invalidation, lambda update, ssm)
#      Both trust ONLY your repo on your deploy branch, using the repo's
#      actual OIDC sub format (new repos issue immutable owner@id/repo@id subs).
#   5. GitHub Variables (non-secret config) + Secrets (tokens only)
#
# Run with an admin AWS profile (the ONLY time admin credentials are used;
# deactivate the key afterwards):
#   $env:AWS_PROFILE = "admin"
#   ./scripts/bootstrap.ps1 -App my-app -Domain app.example.com -CfZoneId <zone> -CfToken (Get-Clipboard)
#
# Prerequisites: aws CLI (admin profile), gh CLI authenticated.
# Non-Windows: runs under PowerShell 7 (pwsh).

param(
    [string]$App         = "",
    [string]$Domain      = "",
    [string]$Environment = "prod",
    [string]$Region      = "us-west-2",
    [string]$GithubRepo  = "",
    [string]$Branch      = "main",
    [string]$CfZoneId    = "",
    [string]$CfToken     = "",
    [string]$AppSecrets  = "{}",
    [string]$GhToken     = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Probe an aws CLI call that is EXPECTED to fail sometimes (e.g. head-bucket
# on a missing bucket). Windows PowerShell 5.1 turns native stderr into a
# terminating error under EAP=Stop, so relax it and report the exit code.
function Test-Aws {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & aws @args 2>&1 | Out-Null } catch { }
    $ErrorActionPreference = $eap
    return ($LASTEXITCODE -eq 0)
}

function Ask([string]$Prompt, [string]$Current) {
    if ($Current) { return $Current }
    return (Read-Host $Prompt).Trim()
}

$App        = Ask "App name (kebab-case, prefixes all AWS resources)" $App
$Domain     = Ask "Custom domain (e.g. app.example.com)" $Domain
$CfZoneId   = Ask "Cloudflare Zone ID (domain Overview page, right column)" $CfZoneId
$GithubRepo = Ask "GitHub repo (org/name)" $GithubRepo
if (-not $App -or -not $Domain -or -not $CfZoneId -or -not $GithubRepo) {
    throw "App, Domain, CfZoneId, and GithubRepo are all required."
}

$CfToken = $CfToken.Trim()
if (-not $CfToken) { $CfToken = (Read-Host "Cloudflare API token (Zone:DNS:Edit)").Trim() }
if ($CfToken) {
    try {
        $verify = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/user/tokens/verify" `
            -Headers @{ Authorization = "Bearer $CfToken" }
        if (-not $verify.success) { throw "verify returned success=false" }
        Write-Host "Cloudflare token verified (status: $($verify.result.status))"
    } catch {
        throw "Cloudflare token failed verification - copy it again from the dashboard. ($_)"
    }
} else {
    Write-Warning "No Cloudflare token - CLOUDFLARE_API_TOKEN will NOT be set. Re-run with -CfToken later (idempotent)."
}
if (-not $GhToken) { $GhToken = (gh auth token).Trim() }
if (-not $GhToken) { throw "No GitHub token - run 'gh auth login' first." }

# Account id comes from the profile - never typed, never wrong.
$identity  = aws sts get-caller-identity --output json | ConvertFrom-Json
$AccountId = $identity.Account

$TfBucket = "$App-tf-state"
$SsmPath  = "/$App/$Environment/secrets"
$OidcArn  = "arn:aws:iam::${AccountId}:oidc-provider/token.actions.githubusercontent.com"

# New GitHub repos issue IMMUTABLE OIDC subject claims (repo:owner@id/repo@id).
# Ask GitHub which prefix this repo actually uses and trust both forms.
$env:GH_TOKEN = $GhToken
$RepoSubs = @("repo:${GithubRepo}:ref:refs/heads/${Branch}")
$subInfo = gh api "repos/$GithubRepo/actions/oidc/customization/sub" 2>$null | ConvertFrom-Json
if ($subInfo -and $subInfo.sub_claim_prefix -and $subInfo.sub_claim_prefix -ne "repo:$GithubRepo") {
    $RepoSubs += "$($subInfo.sub_claim_prefix):ref:refs/heads/${Branch}"
}
$RepoSubJson = ($RepoSubs | ForEach-Object { '"' + $_ + '"' }) -join ", "

Write-Host ""
Write-Host "=== spa-on-aws v2 bootstrap ===" -ForegroundColor Cyan
Write-Host "Caller:      $($identity.Arn)"
Write-Host "Account:     $AccountId"
Write-Host "App:         $App"
Write-Host "Domain:      $Domain"
Write-Host "Environment: $Environment"
Write-Host "Region:      $Region"
Write-Host "TF state:    s3://$TfBucket"
Write-Host "SSM path:    $SsmPath"
Write-Host "OIDC trust:  $($RepoSubs -join '  |  ')"
Write-Host "Roles:       $App-terraform, $App-ci"
Write-Host "Repo:        $GithubRepo ($Branch)"
Write-Host ""
if (-not $Force) {
    $confirm = Read-Host "Proceed? [y/N]"
    if ($confirm -notmatch "^[Yy]$") { Write-Host "Aborted."; exit 0 }
}

# -- 1. Terraform state bucket ------------------------------------------------
Write-Host "`n[1/5] Terraform state bucket: $TfBucket"
if (Test-Aws s3api head-bucket --bucket $TfBucket) {
    Write-Host "      Already exists"
} else {
    aws s3 mb "s3://$TfBucket" --region $Region | Out-Null
    aws s3api put-bucket-versioning --bucket $TfBucket --versioning-configuration Status=Enabled
    aws s3api put-public-access-block --bucket $TfBucket --public-access-block-configuration `
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
    Write-Host "      Created with versioning + public access block"
}

# -- 2. GitHub OIDC provider --------------------------------------------------
Write-Host "`n[2/5] OIDC provider: token.actions.githubusercontent.com"
$providers = aws iam list-open-id-connect-providers --output json | ConvertFrom-Json
if ($providers.OpenIDConnectProviderList.Arn -contains $OidcArn) {
    Write-Host "      Already exists"
} else {
    aws iam create-open-id-connect-provider `
        --url "https://token.actions.githubusercontent.com" `
        --client-id-list "sts.amazonaws.com" `
        --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" | Out-Null
    Write-Host "      Created"
}

# -- Shared trust policy ------------------------------------------------------
$trust = @"
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$OidcArn" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": [$RepoSubJson] }
    }
  }]
}
"@
$trustFile = New-TemporaryFile
Set-Content -Path $trustFile -Value $trust -Encoding ascii

function Set-ProjectRole([string]$Name, [string]$PolicyJson) {
    if (Test-Aws iam get-role --role-name $Name) {
        aws iam update-assume-role-policy --role-name $Name --policy-document "file://$trustFile"
        Write-Host "      Role exists - trust policy refreshed"
    } else {
        aws iam create-role --role-name $Name `
            --assume-role-policy-document "file://$trustFile" `
            --tags Key=Project,Value=$App Key=ManagedBy,Value=bootstrap | Out-Null
        Write-Host "      Created"
    }
    $polFile = New-TemporaryFile
    Set-Content -Path $polFile -Value $PolicyJson -Encoding ascii
    aws iam put-role-policy --role-name $Name --policy-name "$Name-policy" --policy-document "file://$polFile"
    Remove-Item $polFile
    Write-Host "      Inline policy set: $Name-policy"
}

# -- 3. Terraform role - scoped to this stack (not AdministratorAccess) -------
# Covers the full template: S3/CloudFront/ACM plus the optional Lambda +
# API Gateway backend (IAM actions restricted to {app}-* roles).
Write-Host "`n[3/5] IAM role: $App-terraform"
$tfPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TfStateAndAssets",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::$TfBucket", "arn:aws:s3:::$TfBucket/*",
        "arn:aws:s3:::$App-assets", "arn:aws:s3:::$App-assets/*"
      ]
    },
    { "Sid": "CloudFront",  "Effect": "Allow", "Action": "cloudfront:*", "Resource": "*" },
    { "Sid": "Acm",         "Effect": "Allow", "Action": "acm:*",        "Resource": "*" },
    { "Sid": "ApiGateway",  "Effect": "Allow", "Action": "apigateway:*", "Resource": "*" },
    {
      "Sid": "Lambda",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": "arn:aws:lambda:${Region}:${AccountId}:function:$App*"
    },
    {
      "Sid": "LambdaIam",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole", "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::${AccountId}:role/$App-*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": "arn:aws:logs:${Region}:${AccountId}:log-group:/aws/lambda/$App*"
    },
    {
      "Sid": "Ssm",
      "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter",
                 "ssm:AddTagsToResource", "ssm:ListTagsForResource"],
      "Resource": "arn:aws:ssm:${Region}:${AccountId}:parameter$SsmPath"
    },
    { "Sid": "SsmDescribe", "Effect": "Allow", "Action": "ssm:DescribeParameters", "Resource": "*" }
  ]
}
"@
Set-ProjectRole "$App-terraform" $tfPolicy

# -- 4. CI role - deploys only ------------------------------------------------
Write-Host "`n[4/5] IAM role: $App-ci"
$ciPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssetsSync",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$App-assets", "arn:aws:s3:::$App-assets/*"]
    },
    { "Sid": "Invalidate", "Effect": "Allow", "Action": "cloudfront:CreateInvalidation", "Resource": "*" },
    {
      "Sid": "LambdaDeploy",
      "Effect": "Allow",
      "Action": ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"],
      "Resource": "arn:aws:lambda:${Region}:${AccountId}:function:$App"
    },
    {
      "Sid": "Ssm",
      "Effect": "Allow",
      "Action": ["ssm:PutParameter", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${Region}:${AccountId}:parameter$SsmPath"
    }
  ]
}
"@
Set-ProjectRole "$App-ci" $ciPolicy
Remove-Item $trustFile

# -- 5. GitHub config ---------------------------------------------------------
# Non-secret config goes to VARIABLES, not Secrets: GitHub masks any workflow
# output containing a secret's value, so storing e.g. the app name as a secret
# silently breaks job outputs like "s3_bucket={app}-assets".
Write-Host "`n[5/5] GitHub config on $GithubRepo"
$variables = [ordered]@{
    "AWS_ACCOUNT_ID"          = $AccountId
    "TF_STATE_BUCKET"         = $TfBucket
    "TF_VAR_APP_NAME"         = $App
    "TF_VAR_ENVIRONMENT"      = $Environment
    "TF_VAR_CUSTOM_DOMAIN"    = $Domain
    "TF_VAR_SSM_SECRET_PATH"  = $SsmPath
    "CLOUDFLARE_ZONE_ID"      = $CfZoneId
}
foreach ($k in $variables.Keys) {
    Write-Host "      var:    $k"
    gh variable set $k --repo $GithubRepo --body $variables[$k]
}
$secrets = [ordered]@{
    "GH_TOKEN"    = $GhToken
    "APP_SECRETS" = $AppSecrets
}
if ($CfToken) { $secrets["CLOUDFLARE_API_TOKEN"] = $CfToken }
foreach ($k in $secrets.Keys) {
    Write-Host "      secret: $k"
    $secrets[$k] | gh secret set $k --repo $GithubRepo
}

Write-Host ""
Write-Host "=== Bootstrap complete ===" -ForegroundColor Green
Write-Host "Roles trust only $GithubRepo ($Branch) via OIDC - no AWS keys stored anywhere."
Write-Host "You can now DEACTIVATE the admin access key used for this run."
Write-Host ""
Write-Host "Next: push terraform/ to provision, then frontend/ + backend/ to deploy."
