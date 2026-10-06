[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$appDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$voiceDirectory = [IO.Path]::GetFullPath((Join-Path $appDirectory ".voice"))
if (-not $voiceDirectory.StartsWith($appDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Voice runtime must remain inside the application workspace."
}
$environmentDirectory = Join-Path $voiceDirectory "venv"
$pythonExecutable = Join-Path $environmentDirectory "Scripts/python.exe"
$modelDirectory = Join-Path $voiceDirectory "model"
New-Item -ItemType Directory -Path $voiceDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $pythonExecutable -PathType Leaf)) {
    & py -3.12 -m venv $environmentDirectory
    if ($LASTEXITCODE -ne 0) { throw "Install Python 3.12 before preparing local voice." }
}

# Setup is the only step allowed to download. No app credentials are loaded.
$env:PIP_CACHE_DIR = Join-Path $voiceDirectory "pip-cache"
$env:HF_HOME = Join-Path $voiceDirectory "hf-cache"
$env:HF_HUB_DISABLE_TELEMETRY = "1"
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = "1"
$env:HF_HUB_OFFLINE = "0"
$env:HF_HUB_DISABLE_XET = "1"
& $pythonExecutable -m pip install --quiet --disable-pip-version-check --index-url https://pypi.org/simple -r (Join-Path $PSScriptRoot "voice-requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install the local voice dependencies." }

$downloadProgram = @'
import json, pathlib, sys
from faster_whisper import download_model, WhisperModel
folder = pathlib.Path(sys.argv[1]).resolve()
download_model("Systran/faster-whisper-small", output_dir=str(folder), cache_dir=sys.argv[2], use_auth_token=False)
WhisperModel(str(folder), device="cpu", compute_type="int8", cpu_threads=8, num_workers=1, local_files_only=True)
print(json.dumps({"ready": True, "model": "Systran/faster-whisper-small", "compute": "cpu/int8", "model_bytes": sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())}))
'@
$downloadProgram | & $pythonExecutable - $modelDirectory (Join-Path $voiceDirectory "hf-cache")
if ($LASTEXITCODE -ne 0) { throw "Could not download or validate the local small model. Rerun setup to resume." }
Write-Output "Local voice ready. Python: $pythonExecutable"
Write-Output "Model: $modelDirectory"
