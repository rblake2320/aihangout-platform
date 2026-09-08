Set-StrictMode -Version Latest

function Invoke-DeploymentCommand {
    param(
        [Parameter(Mandatory)][string] $Command,
        [string[]] $Arguments = @()
    )
    & $Command @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "Deployment stopped: $Command exited with code $code."
    }
}
