param(
  [Parameter(Mandatory = $true)]
  [string]$VersionId,
  [string]$Message = "Rollback edge-license-console",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ($DryRun) {
  npm.cmd exec wrangler -- --version
  if ($LASTEXITCODE -ne 0) { throw "Wrangler is unavailable." }

  Write-Output "DRY_RUN: npm.cmd exec wrangler rollback -- $VersionId --message `"$Message`" --yes"
  return
}

npm.cmd exec wrangler deployments status
if ($LASTEXITCODE -ne 0) { throw "Unable to read current deployment status." }

npm.cmd exec wrangler rollback -- $VersionId --message $Message --yes
if ($LASTEXITCODE -ne 0) { throw "Worker rollback failed." }

npm.cmd exec wrangler deployments status
if ($LASTEXITCODE -ne 0) { throw "Rollback completed, but status verification failed." }
