# Builds dist\RoadMapStudio.exe (Windows) and dist\RoadMapStudio-macOS.zip (universal .app).
# Supply-chain gate: no Go module younger than 72 hours is ever compiled in.
param(
    [string]$UpdateURL = '',   # baked-in default update location (https://... or \\server\share\folder); users can override in the app
    [string]$Notes = ''        # release notes shown in the update prompt
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$rsrc = 'github.com/akavel/rsrc@v0.10.2'

Write-Host '== 72-hour release-age gate'
$mods = @(go list -m -f '{{if not .Main}}{{.Path}}@{{.Version}}{{end}}' all | Where-Object { $_ })
$mods += $rsrc
$cutoff = (Get-Date).ToUniversalTime().AddHours(-72)
foreach ($m in $mods) {
    $path, $ver = $m -split '@'
    $info = Invoke-RestMethod "https://proxy.golang.org/$($path.ToLower())/@v/$ver.info"
    $when = ([datetime]$info.Time).ToUniversalTime()
    if ($when -gt $cutoff) { throw "GATE: $m was published $when - younger than 72 hours. Wait or pin older." }
    Write-Host ("   ok  {0}  ({1:yyyy-MM-dd})" -f $m, $when)
}

Write-Host '== icon and resources'
go run ./tools/mkicon
if ($LASTEXITCODE) { throw 'mkicon failed' }
go run $rsrc -arch amd64 -manifest build/app.manifest -ico build/app.ico -o rsrc_windows_amd64.syso
if ($LASTEXITCODE) { throw 'rsrc failed' }

Write-Host '== tests'
go test ./...
if ($LASTEXITCODE) { throw 'tests failed' }

$version = ([regex]'appVersion\s*=\s*"([^"]+)"').Match((Get-Content main.go -Raw)).Groups[1].Value
$ld = "-s -w -X main.defaultUpdateLocation=$UpdateURL"
Write-Host "== build $version"
New-Item -ItemType Directory -Force dist | Out-Null
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags "-H windowsgui $ld" -o dist/RoadMapStudio.exe .
if ($LASTEXITCODE) { throw 'build failed' }

Write-Host '== macOS (universal: Intel + Apple Silicon)'
$env:GOOS = 'darwin'
foreach ($arch in 'amd64', 'arm64') {
    $env:GOARCH = $arch
    go build -trimpath -ldflags $ld -o "build/mac-$arch" .
    if ($LASTEXITCODE) { throw "macOS $arch build failed" }
}
Remove-Item Env:GOOS, Env:GOARCH
go run ./tools/mkmacapp build/mac-amd64 build/mac-arm64 build/app.icns $version dist/RoadMapStudio-macOS.zip
if ($LASTEXITCODE) { throw 'mac packaging failed' }
Remove-Item build/mac-amd64, build/mac-arm64

Write-Host '== update manifest'
$sha = { param($f) (Get-FileHash $f -Algorithm SHA256).Hash.ToLower() }
$manifest = [ordered]@{
    version = $version; released = (Get-Date -Format 'yyyy-MM-dd'); notes = $Notes
    files = [ordered]@{
        'windows-amd64' = [ordered]@{ name = 'RoadMapStudio.exe'; sha256 = (& $sha dist/RoadMapStudio.exe) }
        'darwin'        = [ordered]@{ name = 'RoadMapStudio-macOS.zip'; sha256 = (& $sha dist/RoadMapStudio-macOS.zip) }
    }
}
[IO.File]::WriteAllText("$PSScriptRoot/dist/latest.json", ($manifest | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
Write-Host "   copy the whole dist\ folder to the update location; the app reads latest.json there"

Get-ChildItem dist | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
