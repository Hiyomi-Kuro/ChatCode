param(
  [Parameter(Mandatory=$true)][ValidateSet('canonical-root','info','exists','list','read','write','create','mkdir')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$RootPath,
  [string]$RelativePath = '',
  [string]$ExpectedHash = '',
  [ValidateRange(1,67108864)][long]$MaxBytes = 1048576,
  [ValidateRange(0,100000)][int]$Offset = 0,
  [ValidateRange(1,500)][int]$Limit = 200
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace ChatCode {
  public struct HandleInfo {
    public uint Attributes;
    public uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint VolumeSerial, SizeHigh, SizeLow, LinkCount, FileIndexHigh, FileIndexLow;
  }
  public sealed class Verified : IDisposable {
    public SafeFileHandle Root;
    public List<SafeFileHandle> Parents = new List<SafeFileHandle>();
    public SafeFileHandle Target;
    public string RootFinal;
    public string TargetFinal;
    public HandleInfo Info;
    public void Dispose() {
      if (Target != null) Target.Dispose();
      for (int i = Parents.Count - 1; i >= 0; i--) Parents[i].Dispose();
      if (Root != null) Root.Dispose();
    }
  }
  public static class SafeFs {
    const uint OPEN_EXISTING = 3, CREATE_NEW = 1;
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, READ_ATTRIBUTES = 0x80;
    const uint SHARE_READ = 1, SHARE_WRITE = 2, SHARE_DELETE = 4;
    const uint BACKUP_SEMANTICS = 0x02000000, OPEN_REPARSE_POINT = 0x00200000;
    const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400;
    [StructLayout(LayoutKind.Sequential)]
    struct BY_HANDLE_FILE_INFORMATION {
      public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
      public uint VolumeSerial, SizeHigh, SizeLow, LinkCount, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint="GetFinalPathNameByHandleW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", EntryPoint="CreateDirectoryW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateDirectoryNative(string path, IntPtr security);
    [DllImport("kernel32.dll", EntryPoint="ReplaceFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ReplaceFileNative(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    [DllImport("kernel32.dll", EntryPoint="DeleteFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool DeleteFileNative(string path);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [StructLayout(LayoutKind.Sequential)]
    struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_DISPOSITION_INFO info, uint size);

    static string Normalize(string value) {
      if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("不支持 UNC 路径。");
      if (value.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
      if (value.StartsWith("\\\\", StringComparison.Ordinal)) throw new UnauthorizedAccessException("不支持网络、设备或 UNC 路径。");
      string full = Path.GetFullPath(value);
      string volume = Path.GetPathRoot(full);
      return String.Equals(full, volume, StringComparison.OrdinalIgnoreCase) ? full : full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }
    static bool Inside(string root, string target) {
      string r = Normalize(root), t = Normalize(target);
      string prefix = r.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? r : r + Path.DirectorySeparatorChar;
      return String.Equals(r, t, StringComparison.OrdinalIgnoreCase) || t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }
    static SafeFileHandle Open(string path, uint access, uint share, uint creation, bool directory) {
      uint flags = OPEN_REPARSE_POINT | (directory ? BACKUP_SEMANTICS : 0);
      SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, creation, flags, IntPtr.Zero);
      if (handle == null || handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (handle != null) handle.Dispose();
        throw new Win32Exception(error, "无法安全打开目标路径。");
      }
      return handle;
    }
    static string Final(SafeFileHandle handle) {
      StringBuilder value = new StringBuilder(32768);
      uint count = GetFinalPathNameByHandle(handle, value, (uint)value.Capacity, 0);
      if (count == 0 || count >= value.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法确认文件系统最终路径。");
      return Normalize(value.ToString());
    }
    static HandleInfo Info(SafeFileHandle handle) {
      BY_HANDLE_FILE_INFORMATION value;
      if (!GetFileInformationByHandle(handle, out value)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法读取文件元数据。");
      HandleInfo result = new HandleInfo();
      result.Attributes = value.Attributes; result.CreationLow = value.CreationLow; result.CreationHigh = value.CreationHigh;
      result.AccessLow = value.AccessLow; result.AccessHigh = value.AccessHigh; result.WriteLow = value.WriteLow; result.WriteHigh = value.WriteHigh;
      result.VolumeSerial = value.VolumeSerial; result.SizeHigh = value.SizeHigh; result.SizeLow = value.SizeLow;
      result.LinkCount = value.LinkCount; result.FileIndexHigh = value.FileIndexHigh; result.FileIndexLow = value.FileIndexLow;
      return result;
    }
    static long Size(HandleInfo value) { return ((long)value.SizeHigh << 32) | value.SizeLow; }
    static string Relative(string value, bool allowRoot) {
      if (value == null) throw new UnauthorizedAccessException("相对路径无效。");
      if (value.Length == 0 || value == ".") {
        if (allowRoot) return "";
        throw new UnauthorizedAccessException("必须提供工作区内的相对路径。");
      }
      if (value.Length > 2048 || value.IndexOf(':') >= 0 || value.IndexOf('\0') >= 0 || value.StartsWith("/") || value.StartsWith("\\") || Path.IsPathRooted(value))
        throw new UnauthorizedAccessException("只允许工作区内的相对路径。");
      string[] parts = value.Replace('\\','/').Split('/');
      foreach (string part in parts) {
        if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")) throw new UnauthorizedAccessException("路径含穿越或不安全名称。");
        string stem = part.Split('.')[0];
        if (System.Text.RegularExpressions.Regex.IsMatch(stem, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) throw new UnauthorizedAccessException("路径包含 Windows 保留名称。");
      }
      return String.Join(Path.DirectorySeparatorChar.ToString(), parts);
    }
    static void CheckNoReparse(HandleInfo info) {
      if ((info.Attributes & ATTR_REPARSE) != 0) throw new UnauthorizedAccessException("拒绝通过符号链接、junction 或其他 reparse point 访问路径。");
      if (info.LinkCount > 1) throw new UnauthorizedAccessException("拒绝通过硬链接访问文件。");
    }
    static void DeleteByHandle(SafeFileHandle handle) {
      FILE_DISPOSITION_INFO info = new FILE_DISPOSITION_INFO(); info.DeleteFile = true;
      if (!SetFileInformationByHandle(handle, 4, ref info, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法清理未完成的新文件。");
    }
    static void CheckDirectory(HandleInfo info) {
      if ((info.Attributes & ATTR_DIRECTORY) == 0) throw new IOException("路径组件不是目录。");
    }
    static Verified OpenVerified(string rootPath, string relative, uint access, bool? wantDirectory, bool allowRoot, uint targetShare = SHARE_READ) {
      Verified result = new Verified();
      try {
        string root = Normalize(rootPath);
        result.Root = Open(root, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true);
        result.RootFinal = Final(result.Root);
        result.Info = Info(result.Root);
        CheckNoReparse(result.Info); CheckDirectory(result.Info);
        if (!String.Equals(result.RootFinal, root, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("已授权目录的最终路径发生变化。");
        string normalized = Relative(relative, allowRoot);
        if (normalized.Length == 0) {
        if (wantDirectory.HasValue && !wantDirectory.Value) throw new IOException("工作区根目录不是文件。");
          result.Target = result.Root; result.Root = null;
          result.TargetFinal = result.RootFinal; result.Info = Info(result.Target);
          return result;
        }
        string[] parts = normalized.Split(Path.DirectorySeparatorChar);
        string current = root;
        for (int i = 0; i < parts.Length - 1; i++) {
          current = Path.Combine(current, parts[i]);
          SafeFileHandle parent = Open(current, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true);
          HandleInfo parentInfo = Info(parent);
          CheckNoReparse(parentInfo); CheckDirectory(parentInfo);
          string actual = Final(parent);
          if (!Inside(result.RootFinal, actual)) { parent.Dispose(); throw new UnauthorizedAccessException("路径离开了已授权目录。"); }
          result.Parents.Add(parent);
        }
        string target = Path.Combine(current, parts[parts.Length - 1]);
        result.Target = Open(target, access, targetShare, OPEN_EXISTING, true);
        result.Info = Info(result.Target); CheckNoReparse(result.Info);
        if (wantDirectory.HasValue && wantDirectory.Value) CheckDirectory(result.Info);
        else if (wantDirectory.HasValue && (result.Info.Attributes & ATTR_DIRECTORY) != 0) throw new IOException("目标是目录。");
        result.TargetFinal = Final(result.Target);
        if (!Inside(result.RootFinal, result.TargetFinal)) throw new UnauthorizedAccessException("最终文件路径离开了已授权目录。");
        return result;
      } catch { result.Dispose(); throw; }
    }
    static Verified OpenParent(string rootPath, string relative) {
      string normalized = Relative(relative, false);
      int split = normalized.LastIndexOf(Path.DirectorySeparatorChar);
      string parent = split < 0 ? "" : normalized.Substring(0, split);
      return OpenVerified(rootPath, parent, READ_ATTRIBUTES, true, true);
    }
    static string Hash(byte[] data) {
      using (SHA256 sha = SHA256.Create()) {
        byte[] digest = sha.ComputeHash(data); StringBuilder value = new StringBuilder();
        foreach (byte item in digest) value.Append(item.ToString("x2"));
        return value.ToString();
      }
    }
    static string Modified(HandleInfo info) {
      long ticks = ((long)info.WriteHigh << 32) | info.WriteLow;
      return DateTime.FromFileTimeUtc(ticks).ToString("o");
    }
    public static string CanonicalRoot(string rootPath) {
      string root = Normalize(rootPath);
      using (SafeFileHandle handle = Open(root, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true)) {
        HandleInfo info = Info(handle); CheckNoReparse(info); CheckDirectory(info); return Final(handle);
      }
    }
    public static object GetInfo(string root, string relative) {
      using (Verified item = OpenVerified(root, relative, READ_ATTRIBUTES, null, true)) {
        return new { path = item.TargetFinal, isDirectory = (item.Info.Attributes & ATTR_DIRECTORY) != 0, size = Size(item.Info), modified = Modified(item.Info) };
      }
    }
    public static bool Exists(string root, string relative) {
      try {
        using (Verified item = OpenVerified(root, relative, READ_ATTRIBUTES, null, false)) { return true; }
      } catch (Win32Exception error) {
        if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return false;
        throw;
      }
    }
    public static object List(string root, string relative, int offset, int limit) {
      using (Verified item = OpenVerified(root, relative, READ_ATTRIBUTES, true, true)) {
        List<object> entries = new List<object>();
        List<string> names = new List<string>();
        foreach (string candidate in Directory.EnumerateFileSystemEntries(item.TargetFinal)) {
          if (names.Count >= 10001) throw new IOException("目录条目超过 10000 项的单次分页扫描上限。");
          names.Add(candidate);
        }
        names.Sort(StringComparer.OrdinalIgnoreCase);
        int total = names.Count;
        int end = Math.Min(total, offset + limit);
        for (int entryIndex = Math.Min(offset, total); entryIndex < end; entryIndex++) {
          string candidate = names[entryIndex];
          string name = Path.GetFileName(candidate);
          string child = relative == "" || relative == "." ? name : relative.Replace('/',Path.DirectorySeparatorChar).Replace('\\',Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar + name;
          try {
            using (Verified found = OpenVerified(root, child, READ_ATTRIBUTES, null, false)) {
              entries.Add(new { name = name, isDirectory = (found.Info.Attributes & ATTR_DIRECTORY) != 0, size = Size(found.Info), modified = Modified(found.Info) });
            }
          } catch (UnauthorizedAccessException) {
            entries.Add(new { name = name, isDirectory = false, size = 0L, modified = (string)null, blocked = true });
          } catch (IOException) { }
        }
        entries.Sort(delegate(object a, object b) {
          string an = (string)a.GetType().GetProperty("name").GetValue(a, null);
          string bn = (string)b.GetType().GetProperty("name").GetValue(b, null);
          return StringComparer.OrdinalIgnoreCase.Compare(an, bn);
        });
        return new { entries = entries, offset = offset, total = total, nextOffset = end < total ? (int?)end : null };
      }
    }
    public static string Read(string root, string relative, long maxBytes) {
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false)) {
        long size = Size(item.Info);
        if (size > maxBytes) throw new IOException("文件超过单次读取上限。");
        using (FileStream stream = new FileStream(item.Target, FileAccess.Read, 8192, false)) {
          byte[] data = new byte[(int)size]; int total = 0;
          while (total < data.Length) { int count = stream.Read(data, total, data.Length - total); if (count == 0) break; total += count; }
          if (total != data.Length) Array.Resize(ref data, total);
          return Convert.ToBase64String(data);
        }
      }
    }
    public static object Write(string root, string relative, string expectedHash, string contentBase64) {
      byte[] replacement = Convert.FromBase64String(contentBase64);
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false, SHARE_READ | SHARE_WRITE | SHARE_DELETE)) {
        byte[] original;
        using (FileStream stream = new FileStream(item.TargetFinal, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) {
          if (stream.Length > 16777216) throw new IOException("拒绝修改超过 16 MiB 的文件。");
          original = new byte[(int)stream.Length]; int count = 0;
          while (count < original.Length) { int read = stream.Read(original, count, original.Length - count); if (read == 0) break; count += read; }
          if (count != original.Length) Array.Resize(ref original, count);
          string actualHash = Hash(original);
          if (!String.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件版本已变化，请重新读取并生成 Diff。");
        }
        string temporary = Path.Combine(Path.GetDirectoryName(item.TargetFinal), ".chatcode-" + Guid.NewGuid().ToString("N") + ".tmp");
        bool replaced = false;
        try {
          using (SafeFileHandle staged = Open(temporary, GENERIC_READ | GENERIC_WRITE, SHARE_READ, CREATE_NEW, false)) {
            HandleInfo stagedInfo = Info(staged); CheckNoReparse(stagedInfo);
            string stagedFinal = Final(staged);
            if (!Inside(item.RootFinal, stagedFinal)) throw new UnauthorizedAccessException("暂存文件路径离开了已授权目录。");
            using (FileStream stream = new FileStream(staged, FileAccess.Write, 8192, false)) {
              stream.Write(replacement, 0, replacement.Length); stream.Flush(true);
            }
          }
          byte[] current;
          using (FileStream stream = new FileStream(item.TargetFinal, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            if (stream.Length > 16777216) throw new IOException("拒绝修改超过 16 MiB 的文件。");
            current = new byte[(int)stream.Length]; int count = 0;
            while (count < current.Length) { int read = stream.Read(current, count, current.Length - count); if (read == 0) break; count += read; }
            if (count != current.Length) Array.Resize(ref current, count);
          }
          if (!String.Equals(Hash(current), expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件版本在暂存期间已变化；目标文件保持不变，请重新读取并生成 Diff。");
          if (!ReplaceFileNative(item.TargetFinal, temporary, null, 0, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法原子替换目标文件；原文件保持不变。");
          replaced = true;
          return new { path = item.TargetFinal, sha256 = Hash(replacement), bytes = replacement.Length };
        } finally {
          if (!replaced) { try { DeleteFileNative(temporary); } catch { } }
        }
      }
    }
    public static object Create(string root, string relative, string contentBase64) {
      byte[] content = Convert.FromBase64String(contentBase64);
      using (Verified parent = OpenParent(root, relative)) {
        string normalized = Relative(relative, false); string target = Path.Combine(parent.TargetFinal, Path.GetFileName(normalized));
        SafeFileHandle handle = Open(target, GENERIC_READ | GENERIC_WRITE, SHARE_READ, CREATE_NEW, false);
        using (handle) {
          HandleInfo info = Info(handle); CheckNoReparse(info);
          string final = Final(handle);
          if (!Inside(parent.RootFinal, final)) throw new UnauthorizedAccessException("新文件路径离开了已授权目录。");
          using (FileStream stream = new FileStream(handle, FileAccess.ReadWrite, 8192, false)) {
            try { stream.Write(content, 0, content.Length); stream.Flush(true); }
            catch { try { DeleteByHandle(handle); } catch { } throw; }
          }
          return new { path = final, sha256 = Hash(content), bytes = content.Length };
        }
      }
    }
    public static object MakeDirectory(string root, string relative) {
      using (Verified parent = OpenParent(root, relative)) {
        string normalized = Relative(relative, false); string target = Path.Combine(parent.TargetFinal, Path.GetFileName(normalized));
        if (!CreateDirectoryNative(target, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "不能创建目录；目录可能已存在。");
        using (Verified created = OpenVerified(root, normalized, READ_ATTRIBUTES, true, false)) {
          if (!Inside(parent.RootFinal, created.TargetFinal)) throw new UnauthorizedAccessException("新目录路径离开了已授权目录。");
          return new { path = created.TargetFinal, created = true };
        }
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Core.dll')
try {
  $payloadText = [Console]::In.ReadToEnd()
  $payload = if ($payloadText) { ConvertFrom-Json -InputObject $payloadText } else { $null }
  if ($Operation -eq 'canonical-root') {
    [Console]::Out.Write([ChatCode.SafeFs]::CanonicalRoot($RootPath))
  } elseif ($Operation -eq 'info') {
    $result = [ChatCode.SafeFs]::GetInfo($RootPath, $RelativePath)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'exists') {
    [Console]::Out.Write((ConvertTo-Json -InputObject ([ChatCode.SafeFs]::Exists($RootPath, $RelativePath))))
  } elseif ($Operation -eq 'list') {
    $result = [ChatCode.SafeFs]::List($RootPath, $RelativePath, $Offset, $Limit)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'read') {
    [Console]::Out.Write([ChatCode.SafeFs]::Read($RootPath, $RelativePath, $MaxBytes))
  } elseif ($Operation -eq 'write') {
    if (!$payload -or $null -eq $payload.content) { throw '缺少待写入内容。' }
    $result = [ChatCode.SafeFs]::Write($RootPath, $RelativePath, $ExpectedHash, [string]$payload.content)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'create') {
    if (!$payload -or $null -eq $payload.content) { throw '缺少待写入内容。' }
    $result = [ChatCode.SafeFs]::Create($RootPath, $RelativePath, [string]$payload.content)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'mkdir') {
    $result = [ChatCode.SafeFs]::MakeDirectory($RootPath, $RelativePath)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  }
} catch {
  $message = ($_.Exception.Message -replace '[\r\n]+',' ').Trim().Substring(0, [Math]::Min(300, ($_.Exception.Message -replace '[\r\n]+',' ').Trim().Length))
  [Console]::Error.WriteLine(('CC:filesystem:{0}' -f $message))
  exit 2
}
