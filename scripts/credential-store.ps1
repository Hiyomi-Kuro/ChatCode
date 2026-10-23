param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'set', 'status', 'delete')]
  [string]$Operation
)

$ErrorActionPreference = 'Stop'
$target = if ($env:CHATCODE_CREDENTIAL_TARGET) { $env:CHATCODE_CREDENTIAL_TARGET } else { 'ChatCode/SecureMcpTunnel/RuntimeApiKey' }
if ($target -notmatch '^ChatCode/[A-Za-z0-9_./-]{1,180}$') { throw 'Credential target is invalid.' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct ChatCodeCredential {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public UInt32 LastWrittenLow;
    public UInt32 LastWrittenHigh;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
}

public static class ChatCodeCredentialNative {
    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWriteW(ref ChatCodeCredential credential, UInt32 flags);

    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredReadW(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDeleteW(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll")]
    public static extern void CredFree(IntPtr credential);
}
'@ -ErrorAction Stop | Out-Null

function Read-TargetCredential {
  [IntPtr]$pointer = [IntPtr]::Zero
  if (-not [ChatCodeCredentialNative]::CredReadW($target, 1, 0, [ref]$pointer)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) { return $null }
    throw "Credential Manager read failed ($code)."
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][ChatCodeCredential])
    $bytes = New-Object byte[] ([int]$credential.CredentialBlobSize)
    if ($bytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length) }
    return [Text.Encoding]::UTF8.GetString($bytes)
  } finally {
    [ChatCodeCredentialNative]::CredFree($pointer)
  }
}

try {
  switch ($Operation) {
    'status' {
      $secret = Read-TargetCredential
      [Console]::Out.WriteLine((@{ configured = ($null -ne $secret -and $secret.Length -gt 0) } | ConvertTo-Json -Compress))
    }
    'get' {
      $secret = Read-TargetCredential
      [Console]::Out.WriteLine((@{ secret = $secret } | ConvertTo-Json -Compress))
    }
    'set' {
      $requestText = [Console]::In.ReadToEnd()
      $request = $requestText | ConvertFrom-Json
      $secret = [string]$request.secret
      if ([string]::IsNullOrWhiteSpace($secret) -or $secret.Length -gt 4096 -or $secret -match '[\r\n\0]') { throw 'Runtime API key is empty or invalid.' }
      $bytes = [Text.Encoding]::UTF8.GetBytes($secret)
      $targetPointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($target)
      $userPointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('ChatCode')
      $blobPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPointer, $bytes.Length)
        $credential = New-Object ChatCodeCredential
        $credential.Type = 1
        $credential.TargetName = $targetPointer
        $credential.CredentialBlobSize = [uint32]$bytes.Length
        $credential.CredentialBlob = $blobPointer
        $credential.Persist = 2
        $credential.UserName = $userPointer
        if (-not [ChatCodeCredentialNative]::CredWriteW([ref]$credential, 0)) {
          $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          throw "Credential Manager write failed ($code)."
        }
      } finally {
        for ($i = 0; $i -lt $bytes.Length; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($blobPointer, $i, 0) }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPointer)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($targetPointer)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($userPointer)
        [Array]::Clear($bytes, 0, $bytes.Length)
        $secret = $null
        $requestText = $null
      }
      [Console]::Out.WriteLine('{"configured":true}')
    }
    'delete' {
      if (-not [ChatCodeCredentialNative]::CredDeleteW($target, 1, 0)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -ne 1168) { throw "Credential Manager delete failed ($code)." }
      }
      [Console]::Out.WriteLine('{"configured":false}')
    }
  }
} catch {
  [Console]::Error.WriteLine('Credential Manager operation failed.')
  exit 1
}
