# Bootstrap toolchain Android minimal untuk build Fleet Guard.
#
# Dipakai karena mesin ini punya Android Studio + JDK, tapi TIDAK punya
# cmdline-tools (jadi sdkmanager tidak bisa dipakai) dan tidak punya
# distribusi Gradle (jadi gradlew/gradle-wrapper.jar tidak bisa dibuat).
#
# Script ini mengunduh dua hal yang hilang dan tidak lebih:
#   1. SDK Platform 36  (android.jar untuk compileSdk = 36)
#   2. Gradle 9.5.0
#
# Sudah build-tools 36.0.0, jadi tidak perlu diunduh.
#
# Pakai (PowerShell memblokir .ps1 secara default):
#   powershell -ExecutionPolicy Bypass -File android\tools\bootstrap-toolchain.ps1
#
# Semua langkah idempoten: yang sudah ada dilewati.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$sdk    = "$env:LOCALAPPDATA\Android\Sdk"
$dist   = "$env:USERPROFILE\.gradle-dist"
$dl     = "$env:LOCALAPPDATA\Temp\opencode\dl"

# Gradle 9.6.0 menghapus org.gradle.api.problems.internal.InternalProblems yang
# masih dipakai AGP, jadi 9.6 ke atas TIDAK bisa dipakai dengan AGP 8.13.
$GRADLE_VERSION = '9.5.0'

New-Item -ItemType Directory -Force -Path $dl, $dist, "$sdk\licenses" | Out-Null

function Step($msg) { Write-Host "[$(Get-Date -Format HH:mm:ss)] $msg" }

# --- license (kalau belum ada, AGP menolak dengan "license not accepted") ----
$licPath = "$sdk\licenses\android-sdk-license"
if (-not (Test-Path $licPath)) {
    @(
        '24333f8a63b6825ea9c5514f83c2829b004d1fee',
        'd56f5187479451eabf01fb78af6dfcb131a6481e',
        '8933bad161af4178b1185d1a37fbf41ea5269c55'
    ) | Set-Content -Path $licPath -Encoding ascii
    Step 'license SDK ditulis'
} else {
    Step 'license SDK sudah ada'
}

# --- 1. SDK Platform 36 -------------------------------------------------------
$platDir = "$sdk\platforms\android-36"
if (Test-Path "$platDir\android.jar") {
    Step 'SDK platform 36 sudah ada, dilewati'
} else {
    $zip = "$dl\platform-36_r02.zip"
    if (-not (Test-Path $zip)) {
        Step 'unduh SDK platform 36 (63 MB)...'
        Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/platform-36_r02.zip' `
                         -OutFile $zip -TimeoutSec 600
    }
    Step 'ekstrak platform 36...'
    $tmp = "$dl\plat_x"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (Test-Path $platDir) { Remove-Item $platDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path "$sdk\platforms" | Out-Null
    Move-Item $inner.FullName $platDir
    Remove-Item $tmp -Recurse -Force
    Step "android.jar = $((Get-Item "$platDir\android.jar").Length) bytes"
}

# --- 2. Gradle ----------------------------------------------------------------
if (Test-Path "$dist\gradle-$GRADLE_VERSION\bin\gradle.bat") {
    Step "gradle $GRADLE_VERSION sudah ada, dilewati"
} else {
    $gz = "$dl\gradle-$GRADLE_VERSION-bin.zip"
    if (-not (Test-Path $gz)) {
        Step "unduh gradle $GRADLE_VERSION (140 MB)..."
        Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" `
                         -OutFile $gz -TimeoutSec 1800
    }
    Step 'ekstrak gradle...'
    Expand-Archive -Path $gz -DestinationPath $dist -Force
    Step 'gradle diekstrak'
}

# --- verifikasi --------------------------------------------------------------
Write-Host ''
Write-Host '=== VERIFIKASI ==='
$ok = $true
foreach ($p in @("$platDir\android.jar",
                 "$dist\gradle-$GRADLE_VERSION\bin\gradle.bat",
                 "$sdk\build-tools\36.0.0\aapt2.exe",
                 "$sdk\build-tools\36.0.0\apksigner.bat",
                 "$env:ProgramFiles\Android\Android Studio\jbr\bin\javac.exe")) {
    if (Test-Path $p) { Write-Host "  OK    $p" } else { Write-Host "  HILANG $p"; $ok = $false }
}

Write-Host ''
if ($ok) {
    Write-Host 'Toolchain siap. Build dengan:'
    Write-Host '  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"'
    Write-Host "  cd fleet-guard\android"
    Write-Host "  & `"`$env:USERPROFILE\.gradle-dist\gradle-$GRADLE_VERSION\bin\gradle.bat`" assembleDebug --console=plain"
} else {
    Write-Host 'Ada komponen yang masih hilang.'
    exit 1
}