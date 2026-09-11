param([Parameter(Mandatory=$true)][string]$Sdk,[Parameter(Mandatory=$true)][string]$Jdk,[Parameter(Mandatory=$true)][string]$Keystore)
$ErrorActionPreference='Stop'
function Check { if($LASTEXITCODE -ne 0){throw "Build command failed: $LASTEXITCODE"} }
$bt=Join-Path $Sdk 'build-tools/35.0.0'
$jar=Join-Path $Sdk 'platforms/android-35/android.jar'
$out=Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null
& "$Jdk/bin/javac.exe" -source 8 -target 8 -classpath $jar -d $out "$PSScriptRoot/MainActivity.java"; Check
$env:JAVA_HOME=$Jdk
& "$bt/d8.bat" --lib $jar --output $out "$out/com/aihangout/installfixture/MainActivity.class"; Check
& "$bt/aapt2.exe" link -I $jar --manifest "$PSScriptRoot/AndroidManifest.xml" -o "$out/unsigned.apk"; Check
Push-Location $out
try { & "$bt/aapt.exe" add unsigned.apk classes.dex; Check } finally { Pop-Location }
& "$bt/zipalign.exe" -f 4 "$out/unsigned.apk" "$out/aligned.apk"; Check
& "$bt/apksigner.bat" sign --ks $Keystore --ks-pass pass:android --out "$out/install-fixture.apk" "$out/aligned.apk"; Check
& "$bt/apksigner.bat" verify "$out/install-fixture.apk"; Check
