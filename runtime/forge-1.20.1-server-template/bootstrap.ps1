$ErrorActionPreference = "Stop"

$templateDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$forgeVersion = "1.20.1-47.4.20"
$installerName = "forge-$forgeVersion-installer.jar"
$installerUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/$forgeVersion/$installerName"
$installerPath = Join-Path $templateDir $installerName

Write-Host "Forge template directory: $templateDir"
Write-Host "Downloading Forge installer: $installerUrl"

if (-not (Test-Path -LiteralPath $installerPath)) {
  Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installerPath
} else {
  Write-Host "Installer already present: $installerPath"
}

Push-Location $templateDir
try {
  Write-Host "Installing Forge server files into template directory..."
  & java -jar $installerName --installServer .
  if ($LASTEXITCODE -ne 0) {
    throw "Forge installer exited with code $LASTEXITCODE."
  }

  if (-not (Test-Path -LiteralPath (Join-Path $templateDir "run.bat"))) {
    throw "Forge installation completed but run.bat was not created."
  }

  Write-Host "Forge template is ready."
} finally {
  Pop-Location
}
