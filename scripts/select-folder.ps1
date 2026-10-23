$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8
try {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择要由 ChatCode 管理的本机工作区目录'
  $dialog.UseDescriptionForTitle = $true
  $dialog.ShowNewFolderButton = $false
  $result = $dialog.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    [Console]::Out.WriteLine((@{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress))
  } else {
    [Console]::Out.WriteLine('{"cancelled":true}')
  }
} catch {
  [Console]::Error.WriteLine('Windows 文件夹选择器无法启动。')
  exit 1
}
