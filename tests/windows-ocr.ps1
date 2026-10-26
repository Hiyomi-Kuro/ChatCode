param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await-WinRtOperation($Operation, [Type]$ResultType) {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1
    if (-not $asTask) { throw 'Could not find WinRT AsTask adapter.' }
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

$sourceBitmap = $null
$croppedBitmap = $null
$graphics = $null
$stream = $null
$cropPath = Join-Path $env:TEMP ("chatcode-display-ocr-$([guid]::NewGuid().ToString('N')).png")
try {
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $sourceBitmap = [System.Drawing.Bitmap]::FromFile($resolvedPath)
    $cropX = [Math]::Floor($sourceBitmap.Width * 0.69)
    $cropY = [Math]::Floor($sourceBitmap.Height * 0.46)
    $cropWidth = [Math]::Max(1, [Math]::Floor($sourceBitmap.Width * 0.30))
    $cropHeight = [Math]::Max(1, [Math]::Floor($sourceBitmap.Height * 0.11))
    $cropWidth = [Math]::Min($cropWidth, $sourceBitmap.Width - $cropX)
    $cropHeight = [Math]::Min($cropHeight, $sourceBitmap.Height - $cropY)
    $scale = 3
    $croppedBitmap = New-Object System.Drawing.Bitmap -ArgumentList ($cropWidth * $scale), ($cropHeight * $scale)
    $graphics = [System.Drawing.Graphics]::FromImage($croppedBitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $destination = [System.Drawing.Rectangle]::new(0, 0, $cropWidth * $scale, $cropHeight * $scale)
    $source = [System.Drawing.Rectangle]::new($cropX, $cropY, $cropWidth, $cropHeight)
    [void]$graphics.DrawImage($sourceBitmap, $destination, $source, [System.Drawing.GraphicsUnit]::Pixel)
    $croppedBitmap.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $hashRectangle = [System.Drawing.Rectangle]::new(0, 0, $croppedBitmap.Width, $croppedBitmap.Height)
    $locked = $croppedBitmap.LockBits($hashRectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $byteCount = [Math]::Abs($locked.Stride) * $croppedBitmap.Height
        $pixels = New-Object byte[] $byteCount
        [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pixels, 0, $byteCount)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $regionSha256 = [BitConverter]::ToString($sha.ComputeHash($pixels)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    }
    finally { $croppedBitmap.UnlockBits($locked) }

    $storageFileType = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
    $file = Await-WinRtOperation ($storageFileType::GetFileFromPathAsync($cropPath)) $storageFileType
    $streamType = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage,ContentType=WindowsRuntime]
    $stream = Await-WinRtOperation ($file.OpenAsync([Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]::Read)) $streamType
    $decoderType = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $decoder = Await-WinRtOperation ($decoderType::CreateAsync($stream)) $decoderType
    $bitmapType = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $bitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) $bitmapType
    $ocrType = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $engine = $ocrType::TryCreateFromUserProfileLanguages()
    if (-not $engine) { throw 'Windows OCR has no language engine for the current user profile.' }
    $resultType = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
    $result = Await-WinRtOperation ($engine.RecognizeAsync($bitmap)) $resultType
    $textBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$result.Text))
    ConvertTo-Json -Compress -InputObject @{ text_base64 = $textBase64; region_sha256 = $regionSha256 }
}
finally {
    if ($stream) { $stream.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($croppedBitmap) { $croppedBitmap.Dispose() }
    if ($sourceBitmap) { $sourceBitmap.Dispose() }
    Remove-Item -LiteralPath $cropPath -Force -ErrorAction SilentlyContinue
}
