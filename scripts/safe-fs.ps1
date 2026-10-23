param(
  [Parameter(Mandatory=$true)][ValidateSet('canonical-root','info','exists','list','list-cursor','read','read-chunk','hash','write','truncate-staging','write-staged','copy-to-staging','create','mkdir')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$RootPath,
  [string]$RelativePath = '',
  [string]$ExpectedHash = '',
  [ValidateRange(1,67108864)][long]$MaxBytes = 1048576,
  [string]$Offset = '0',
  [ValidateRange(1,500)][int]$Limit = 200,
  [ValidateRange(1,262144)][int]$ChunkLength = 262144,
  [string]$StagingRoot = '',
  [string]$StagingPath = '',
  [string]$Cursor = ''
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
using System.Globalization;
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
    [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFileExNative(string existing, string replacement, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
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
    static SafeFileHandle Duplicate(SafeFileHandle handle) {
      SafeFileHandle copy;
      IntPtr process = GetCurrentProcess();
      if (!DuplicateHandle(process, handle, process, out copy, 0, false, 2)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法复制已验证的文件句柄。");
      return copy;
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
    static string HashStream(Stream stream) {
      long original = stream.Position; stream.Position = 0;
      using (SHA256 sha = SHA256.Create()) {
        byte[] digest = sha.ComputeHash(stream); StringBuilder value = new StringBuilder();
        foreach (byte item in digest) value.Append(item.ToString("x2"));
        stream.Position = original;
        return value.ToString();
      }
    }
    static string Modified(HandleInfo info) {
      long ticks = ((long)info.WriteHigh << 32) | info.WriteLow;
      return DateTime.FromFileTimeUtc(ticks).ToString("o");
    }
    static string Version(HandleInfo info) {
      return info.VolumeSerial.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8") + ":" +
        info.WriteHigh.ToString("x8") + info.WriteLow.ToString("x8") + ":" + Size(info).ToString(CultureInfo.InvariantCulture);
    }
    public static string CanonicalRoot(string rootPath) {
      string root = Normalize(rootPath);
      using (SafeFileHandle handle = Open(root, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true)) {
        HandleInfo info = Info(handle); CheckNoReparse(info); CheckDirectory(info); return Final(handle);
      }
    }
    public static object GetInfo(string root, string relative) {
      using (Verified item = OpenVerified(root, relative, READ_ATTRIBUTES, null, true)) {
        return new { path = item.TargetFinal, isDirectory = (item.Info.Attributes & ATTR_DIRECTORY) != 0, size = Size(item.Info), sizeBytes = Size(item.Info).ToString(CultureInfo.InvariantCulture), modified = Modified(item.Info), version = Version(item.Info) };
      }
    }
    public static object HashFile(string root, string relative) {
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false)) {
        using (FileStream stream = new FileStream(Duplicate(item.Target), FileAccess.Read, 65536, false)) {
          using (SHA256 sha = SHA256.Create()) {
            byte[] digest = sha.ComputeHash(stream); StringBuilder value = new StringBuilder();
            foreach (byte part in digest) value.Append(part.ToString("x2"));
            return new { sha256 = value.ToString(), sizeBytes = stream.Length.ToString(CultureInfo.InvariantCulture), version = Version(item.Info) };
          }
        }
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
    public static object ListCursor(string root, string relative, string cursor, int limit) {
      if (cursor == null || cursor.Length > 255 || cursor.IndexOf('\0') >= 0) throw new IOException("目录游标无效。");
      using (Verified item = OpenVerified(root, relative, READ_ATTRIBUTES, true, true)) {
        SortedSet<string> names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (string candidate in Directory.EnumerateFileSystemEntries(item.TargetFinal)) {
          total++;
          string name = Path.GetFileName(candidate);
          if (cursor.Length > 0 && StringComparer.OrdinalIgnoreCase.Compare(name, cursor) <= 0) continue;
          names.Add(name);
          if (names.Count > limit + 1) names.Remove(names.Max);
        }
        bool more = names.Count > limit;
        List<object> entries = new List<object>();
        string nextCursor = null;
        int index = 0;
        foreach (string name in names) {
          if (index >= limit) break;
          string child = relative == "" || relative == "." ? name : relative.Replace('/',Path.DirectorySeparatorChar).Replace('\\',Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar + name;
          try {
            using (Verified found = OpenVerified(root, child, READ_ATTRIBUTES, null, false)) {
              entries.Add(new { name = name, isDirectory = (found.Info.Attributes & ATTR_DIRECTORY) != 0, size = Size(found.Info), modified = Modified(found.Info) });
              nextCursor = name;
            }
          } catch (UnauthorizedAccessException) {
            entries.Add(new { name = name, isDirectory = false, size = 0L, modified = (string)null, blocked = true });
            nextCursor = name;
          } catch (IOException) { nextCursor = name; }
          index++;
        }
        return new { entries = entries, total = total, nextCursor = more ? nextCursor : null, hasMore = more };
      }
    }
    public static string Read(string root, string relative, long maxBytes) {
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false)) {
        long size = Size(item.Info);
        if (size > maxBytes) throw new IOException("文件超过单次读取上限。");
        using (FileStream stream = new FileStream(Duplicate(item.Target), FileAccess.Read, 8192, false)) {
          byte[] data = new byte[(int)size]; int total = 0;
          while (total < data.Length) { int count = stream.Read(data, total, data.Length - total); if (count == 0) break; total += count; }
          if (total != data.Length) Array.Resize(ref data, total);
          return Convert.ToBase64String(data);
        }
      }
    }
    public static object ReadChunk(string root, string relative, long offset, int length) {
      if (offset < 0 || length < 1 || length > 262144) throw new ArgumentOutOfRangeException("读取分块参数无效。");
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false)) {
        using (FileStream stream = new FileStream(Duplicate(item.Target), FileAccess.Read, 65536, false)) {
          long size = stream.Length;
          if (offset > size) throw new IOException("字节 offset 超出文件末尾。");
          int count = (int)Math.Min((long)length, size - offset);
          byte[] data = new byte[count]; stream.Position = offset;
          int total = 0;
          while (total < count) { int read = stream.Read(data, total, count - total); if (read == 0) break; total += read; }
          if (total != count) Array.Resize(ref data, total);
          return new { data = Convert.ToBase64String(data), bytesRead = data.Length, sizeBytes = size.ToString(CultureInfo.InvariantCulture), modified = Modified(item.Info), version = Version(item.Info), nextOffset = (offset + data.Length).ToString(CultureInfo.InvariantCulture), eof = offset + data.Length >= size };
        }
      }
    }
    public static object Write(string root, string relative, string expectedHash, string contentBase64) {
      byte[] replacement = Convert.FromBase64String(contentBase64);
      using (Verified item = OpenVerified(root, relative, GENERIC_READ, false, false, SHARE_READ | SHARE_WRITE | SHARE_DELETE)) {
        using (FileStream stream = new FileStream(Duplicate(item.Target), FileAccess.Read, 65536, false)) {
          string actualHash = HashStream(stream);
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
          using (FileStream stream = new FileStream(Duplicate(item.Target), FileAccess.Read, 65536, false)) {
            if (!String.Equals(HashStream(stream), expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件版本在暂存期间已变化；目标文件保持不变，请重新读取并生成 Diff。");
          }
          if (!ReplaceFileNative(item.TargetFinal, temporary, null, 0, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法原子替换目标文件；原文件保持不变。");
          replaced = true;
          return new { path = item.TargetFinal, sha256 = Hash(replacement), bytes = replacement.Length };
        } finally {
          if (!replaced) { try { DeleteFileNative(temporary); } catch { } }
        }
      }
    }
    public static object WriteStaged(string root, string relative, string expectedHash, string stagingRoot, string stagingPath) {
      if (String.IsNullOrWhiteSpace(stagingRoot) || String.IsNullOrWhiteSpace(stagingPath)) throw new UnauthorizedAccessException("缺少受控上传暂存路径。");
      string stagingFinalRoot = Normalize(stagingRoot);
      using (SafeFileHandle stagingRootHandle = Open(stagingFinalRoot, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true)) {
        HandleInfo stagingInfo = Info(stagingRootHandle); CheckNoReparse(stagingInfo); CheckDirectory(stagingInfo);
        if (!String.Equals(Final(stagingRootHandle), stagingFinalRoot, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("上传暂存根目录路径发生变化。");
      }
      using (SafeFileHandle sourceHandle = Open(stagingPath, GENERIC_READ, SHARE_READ, OPEN_EXISTING, false)) {
        HandleInfo sourceInfo = Info(sourceHandle); CheckNoReparse(sourceInfo);
        string sourceFinal = Final(sourceHandle);
        if (!Inside(stagingFinalRoot, sourceFinal)) throw new UnauthorizedAccessException("上传内容不在受控暂存目录内。");
        using (FileStream source = new FileStream(sourceHandle, FileAccess.Read, 65536, false)) {
          using (Verified parent = OpenParent(root, relative)) {
            string normalized = Relative(relative, false);
            string target = Path.Combine(parent.TargetFinal, Path.GetFileName(normalized));
            bool creating = String.IsNullOrEmpty(expectedHash);
            Verified existing = null;
            if (!creating) {
              if (!System.Text.RegularExpressions.Regex.IsMatch(expectedHash, "^[a-fA-F0-9]{64}$")) throw new IOException("文件版本哈希无效。");
              existing = OpenVerified(root, normalized, GENERIC_READ, false, false, SHARE_READ | SHARE_WRITE | SHARE_DELETE);
              using (FileStream current = new FileStream(Duplicate(existing.Target), FileAccess.Read, 65536, false)) {
                if (!String.Equals(HashStream(current), expectedHash, StringComparison.OrdinalIgnoreCase)) { existing.Dispose(); existing = null; throw new IOException("文件版本已变化，拒绝覆盖。"); }
              }
            } else if (Exists(root, normalized)) {
              throw new IOException("目标文件已存在，拒绝覆盖。");
            }
            string temporary = Path.Combine(Path.GetDirectoryName(target), ".chatcode-" + Guid.NewGuid().ToString("N") + ".tmp");
            bool published = false;
            try {
              string outputHash;
              long outputSize;
              using (SafeFileHandle staged = Open(temporary, GENERIC_READ | GENERIC_WRITE, SHARE_READ, CREATE_NEW, false)) {
                HandleInfo stagedInfo = Info(staged); CheckNoReparse(stagedInfo);
                if (!Inside(parent.RootFinal, Final(staged))) throw new UnauthorizedAccessException("写入临时文件路径离开了已授权目录。");
                using (FileStream output = new FileStream(staged, FileAccess.ReadWrite, 65536, false)) {
                  source.Position = 0; source.CopyTo(output, 65536); output.Flush(true); output.Position = 0;
                  outputSize = output.Length; outputHash = HashStream(output);
                }
              }
              if (creating) {
                if (Exists(root, normalized)) throw new IOException("目标文件刚刚创建；保留已有目标。");
                if (!MoveFileExNative(temporary, target, 8)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法原子发布新文件。");
              } else {
                using (FileStream current = new FileStream(Duplicate(existing.Target), FileAccess.Read, 65536, false)) {
                  if (!String.Equals(HashStream(current), expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件版本在提交期间已变化，目标文件保持不变。");
                }
                if (!ReplaceFileNative(existing.TargetFinal, temporary, null, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法原子替换目标文件；原文件保持不变。");
              }
              published = true;
              return new { path = target, sha256 = outputHash, bytes = outputSize, sizeBytes = outputSize.ToString(CultureInfo.InvariantCulture) };
            } finally {
              if (!published) { try { DeleteFileNative(temporary); } catch { } }
              if (existing != null) existing.Dispose();
            }
          }
        }
      }
    }
    public static object TruncateStaging(string stagingRoot, string stagingPath, long length) {
      if (String.IsNullOrWhiteSpace(stagingRoot) || String.IsNullOrWhiteSpace(stagingPath)) throw new UnauthorizedAccessException("缺少受控上传暂存路径。");
      if (length < 0) throw new IOException("暂存文件长度不能为负数。");
      string stagingFinalRoot = Normalize(stagingRoot);
      using (SafeFileHandle stagingRootHandle = Open(stagingFinalRoot, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true)) {
        HandleInfo stagingInfo = Info(stagingRootHandle); CheckNoReparse(stagingInfo); CheckDirectory(stagingInfo);
        string verifiedRoot = Final(stagingRootHandle);
        if (!String.Equals(verifiedRoot, stagingFinalRoot, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("上传暂存根目录路径发生变化。");
        string normalizedPath = Normalize(stagingPath);
        if (!Inside(verifiedRoot, normalizedPath)) throw new UnauthorizedAccessException("暂存文件路径不在受控目录内。");
        using (SafeFileHandle fileHandle = Open(normalizedPath, GENERIC_READ | GENERIC_WRITE, SHARE_READ, OPEN_EXISTING, false)) {
          HandleInfo fileInfo = Info(fileHandle); CheckNoReparse(fileInfo);
          if ((fileInfo.Attributes & ATTR_DIRECTORY) != 0) throw new IOException("上传暂存目标不是普通文件。");
          if (!Inside(verifiedRoot, Final(fileHandle))) throw new UnauthorizedAccessException("暂存文件最终路径离开受控目录。");
          using (FileStream stream = new FileStream(fileHandle, FileAccess.ReadWrite, 65536, false)) {
            if (length > stream.Length) throw new IOException("不能把上传暂存文件扩展到已确认偏移。");
            stream.SetLength(length); stream.Flush(true);
            return new { sizeBytes = stream.Length.ToString(CultureInfo.InvariantCulture) };
          }
        }
      }
    }
    public static object CopyToStaging(string root, string relative, string expectedHash, string stagingRoot, string stagingPath) {
      if (!System.Text.RegularExpressions.Regex.IsMatch(expectedHash ?? "", "^[a-fA-F0-9]{64}$")) throw new IOException("文件版本哈希无效。");
      string stagingFinalRoot = Normalize(stagingRoot);
      using (SafeFileHandle stagingRootHandle = Open(stagingFinalRoot, READ_ATTRIBUTES, SHARE_READ, OPEN_EXISTING, true)) {
        HandleInfo stagingInfo = Info(stagingRootHandle); CheckNoReparse(stagingInfo); CheckDirectory(stagingInfo);
        if (!String.Equals(Final(stagingRootHandle), stagingFinalRoot, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("上传暂存根目录路径发生变化。");
      }
      using (Verified sourceItem = OpenVerified(root, relative, GENERIC_READ, false, false)) {
        string stagedFull = Normalize(stagingPath);
        if (!Inside(stagingFinalRoot, stagedFull)) throw new UnauthorizedAccessException("备份路径不在受控暂存目录内。");
        string actualHash;
        long size;
        using (FileStream source = new FileStream(Duplicate(sourceItem.Target), FileAccess.Read, 65536, false)) {
          actualHash = HashStream(source); size = source.Length;
          if (!String.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件版本已变化，不能创建审批备份。");
          using (SafeFileHandle destination = Open(stagedFull, GENERIC_READ | GENERIC_WRITE, SHARE_READ, CREATE_NEW, false)) {
            HandleInfo destinationInfo = Info(destination); CheckNoReparse(destinationInfo);
            if (!Inside(stagingFinalRoot, Final(destination))) throw new UnauthorizedAccessException("备份文件最终路径离开暂存目录。");
            using (FileStream output = new FileStream(destination, FileAccess.ReadWrite, 65536, false)) {
              source.Position = 0; source.CopyTo(output, 65536); output.Flush(true); output.Position = 0;
              if (!String.Equals(HashStream(output), expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("备份内容哈希校验失败。");
            }
          }
          if (!String.Equals(HashStream(source), expectedHash, StringComparison.OrdinalIgnoreCase)) {
            DeleteFileNative(stagedFull); throw new IOException("源文件在备份期间发生变化。");
          }
        }
        return new { sha256 = actualHash, bytes = size, sizeBytes = size.ToString(CultureInfo.InvariantCulture) };
      }
    }
    public static object Create(string root, string relative, string contentBase64) {
      byte[] content = Convert.FromBase64String(contentBase64);
      using (Verified parent = OpenParent(root, relative)) {
        string normalized = Relative(relative, false); string target = Path.Combine(parent.TargetFinal, Path.GetFileName(normalized));
        string temporary = Path.Combine(parent.TargetFinal, ".chatcode-" + Guid.NewGuid().ToString("N") + ".tmp");
        bool published = false;
        try {
          using (SafeFileHandle handle = Open(temporary, GENERIC_READ | GENERIC_WRITE, SHARE_READ, CREATE_NEW, false)) {
            HandleInfo info = Info(handle); CheckNoReparse(info);
            string final = Final(handle);
            if (!Inside(parent.RootFinal, final)) throw new UnauthorizedAccessException("新文件路径离开了已授权目录。");
            using (FileStream stream = new FileStream(handle, FileAccess.ReadWrite, 8192, false)) {
              stream.Write(content, 0, content.Length); stream.Flush(true);
            }
          }
          if (!MoveFileExNative(temporary, target, 8)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法原子发布新文件；目标已存在或替换失败。");
          published = true;
          return new { path = target, sha256 = Hash(content), bytes = content.Length };
        } finally {
          if (!published) { try { DeleteFileNative(temporary); } catch { } }
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
    $listOffset = 0
    if (![int]::TryParse($Offset, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$listOffset) -or $listOffset -lt 0) { throw '目录 offset 无效。' }
    $result = [ChatCode.SafeFs]::List($RootPath, $RelativePath, $listOffset, $Limit)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'list-cursor') {
    $result = [ChatCode.SafeFs]::ListCursor($RootPath, $RelativePath, $Cursor, $Limit)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'read') {
    [Console]::Out.Write([ChatCode.SafeFs]::Read($RootPath, $RelativePath, $MaxBytes))
  } elseif ($Operation -eq 'read-chunk') {
    $offsetValue = [long]0
    if (![long]::TryParse($Offset, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$offsetValue) -or $offsetValue -lt 0) { throw '字节 offset 无效。' }
    $result = [ChatCode.SafeFs]::ReadChunk($RootPath, $RelativePath, $offsetValue, $ChunkLength)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'hash') {
    $result = [ChatCode.SafeFs]::HashFile($RootPath, $RelativePath)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'write') {
    if (!$payload -or $null -eq $payload.content) { throw '缺少待写入内容。' }
    $result = [ChatCode.SafeFs]::Write($RootPath, $RelativePath, $ExpectedHash, [string]$payload.content)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'write-staged') {
    $result = [ChatCode.SafeFs]::WriteStaged($RootPath, $RelativePath, $ExpectedHash, $StagingRoot, $StagingPath)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'truncate-staging') {
    $stagingLength = [long]0
    if (![long]::TryParse($Offset, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$stagingLength) -or $stagingLength -lt 0) { throw '暂存文件长度无效。' }
    $result = [ChatCode.SafeFs]::TruncateStaging($StagingRoot, $StagingPath, $stagingLength)
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 5))
  } elseif ($Operation -eq 'copy-to-staging') {
    $result = [ChatCode.SafeFs]::CopyToStaging($RootPath, $RelativePath, $ExpectedHash, $StagingRoot, $StagingPath)
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
