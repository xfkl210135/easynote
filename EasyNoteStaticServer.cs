using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class EasyNoteStaticServer
{
    private const int MaximumHeaderBytes = 32 * 1024;
    private const int MaximumBackupBytes = 128 * 1024 * 1024;
    private readonly string root;
    private readonly string rootPrefix;
    private readonly string automaticBackupRoot;
    private readonly TcpListener listener;
    private readonly object backupLock = new object();
    private volatile bool stopping;

    private sealed class RequestData
    {
        public string Method;
        public string Target;
        public byte[] Body;
    }

    private static readonly Dictionary<string, string> MimeTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" },
        { ".map", "application/json; charset=utf-8" },
        { ".webmanifest", "application/manifest+json; charset=utf-8" },
        { ".svg", "image/svg+xml" },
        { ".png", "image/png" },
        { ".jpg", "image/jpeg" },
        { ".jpeg", "image/jpeg" },
        { ".webp", "image/webp" },
        { ".gif", "image/gif" },
        { ".ico", "image/x-icon" }
    };

    public EasyNoteStaticServer(string appRoot, string backupRoot, int port)
    {
        root = Path.GetFullPath(appRoot);
        rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        automaticBackupRoot = Path.GetFullPath(backupRoot);
        listener = new TcpListener(IPAddress.Loopback, port);
    }

    public void Start() { listener.Start(64); }

    public void Run()
    {
        while (!stopping)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch (SocketException) { if (stopping) return; throw; }
            catch (ObjectDisposedException) { return; }
            ThreadPool.QueueUserWorkItem(HandleClient, client);
        }
    }

    public void Stop()
    {
        stopping = true;
        listener.Stop();
    }

    private void HandleClient(object state)
    {
        using (TcpClient client = (TcpClient)state)
        {
            try
            {
                client.NoDelay = true;
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 15000;
                using (NetworkStream stream = client.GetStream())
                {
                    RequestData request = ReadRequest(stream);
                    if (request != null) WriteResponse(stream, request);
                }
            }
            catch (InvalidDataException error)
            {
                try { WriteSimpleResponse(client.GetStream(), "400 Bad Request", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(error.Message), "no-store", false); }
                catch { }
            }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }
    }

    private static RequestData ReadRequest(NetworkStream stream)
    {
        List<byte> header = new List<byte>(1024);
        int matched = 0;
        byte[] terminator = new byte[] { 13, 10, 13, 10 };
        while (matched < terminator.Length)
        {
            int value = stream.ReadByte();
            if (value < 0) return null;
            header.Add((byte)value);
            if (header.Count > MaximumHeaderBytes) throw new InvalidDataException("Request headers are too large");
            matched = value == terminator[matched] ? matched + 1 : (value == terminator[0] ? 1 : 0);
        }

        string headerText = Encoding.ASCII.GetString(header.ToArray());
        string[] lines = headerText.Split(new string[] { "\r\n" }, StringSplitOptions.None);
        string[] requestLine = lines[0].Split(' ');
        if (requestLine.Length < 2) throw new InvalidDataException("Invalid request line");
        int contentLength = 0;
        for (int index = 1; index < lines.Length; index++)
        {
            int colon = lines[index].IndexOf(':');
            if (colon <= 0) continue;
            if (lines[index].Substring(0, colon).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
            {
                if (!Int32.TryParse(lines[index].Substring(colon + 1).Trim(), out contentLength) || contentLength < 0 || contentLength > MaximumBackupBytes) throw new InvalidDataException("Backup request is too large");
            }
        }
        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < body.Length)
        {
            int read = stream.Read(body, offset, body.Length - offset);
            if (read <= 0) throw new InvalidDataException("Request body ended early");
            offset += read;
        }
        return new RequestData { Method = requestLine[0], Target = requestLine[1], Body = body };
    }

    private void WriteResponse(NetworkStream stream, RequestData request)
    {
        string pathOnly = request.Target.Split('?')[0];
        if (request.Method == "POST" && pathOnly.Equals("/__easynote/automatic-backup", StringComparison.Ordinal))
        {
            WriteAutomaticBackupResponse(stream, request.Body);
            return;
        }
        if (request.Method == "GET" && pathOnly.Equals("/__easynote/recovery-candidate", StringComparison.Ordinal))
        {
            WriteRecoveryCandidateResponse(stream);
            return;
        }

        string relative = Uri.UnescapeDataString(pathOnly).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        if (String.IsNullOrWhiteSpace(relative)) relative = "index.html";
        string status = "200 OK";
        string contentType = "application/octet-stream";
        string cacheControl = "no-cache";
        byte[] body;
        string candidate = Path.GetFullPath(Path.Combine(root, relative));

        if (request.Method != "GET" && request.Method != "HEAD")
        {
            status = "405 Method Not Allowed";
            contentType = "text/plain; charset=utf-8";
            body = Encoding.UTF8.GetBytes("Method not allowed");
        }
        else if (!candidate.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate))
        {
            status = "404 Not Found";
            contentType = "text/plain; charset=utf-8";
            body = Encoding.UTF8.GetBytes("Not found");
        }
        else
        {
            body = File.ReadAllBytes(candidate);
            string knownType;
            if (MimeTypes.TryGetValue(Path.GetExtension(candidate), out knownType)) contentType = knownType;
            if (relative.StartsWith("assets" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                relative.StartsWith("icons" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                relative.StartsWith("workbox-", StringComparison.OrdinalIgnoreCase)) cacheControl = "public, max-age=31536000, immutable";
        }
        WriteSimpleResponse(stream, status, contentType, body, cacheControl, request.Method == "HEAD");
    }

    private void WriteAutomaticBackupResponse(NetworkStream stream, byte[] body)
    {
        string json;
        try { json = new UTF8Encoding(false, true).GetString(body); }
        catch { WriteSimpleResponse(stream, "400 Bad Request", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"invalid UTF-8\"}"), "no-store", false); return; }
        string compactStart = json.TrimStart();
        bool valid = compactStart.StartsWith("{", StringComparison.Ordinal) &&
            Regex.IsMatch(json, "\\\"format\\\"\\s*:\\s*\\\"easynote-portable\\\"") &&
            Regex.IsMatch(json, "\\\"version\\\"\\s*:\\s*8(?:\\s*[,}])") &&
            Regex.IsMatch(json, "\\\"notes\\\"\\s*:\\s*\\[") &&
            Regex.IsMatch(json, "\\\"categories\\\"\\s*:\\s*\\[");
        if (!valid)
        {
            WriteSimpleResponse(stream, "400 Bad Request", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"invalid EasyNote backup\"}"), "no-store", false);
            return;
        }

        string createdAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        string checksum = Sha256(body);
        string stamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ", CultureInfo.InvariantCulture);
        string baseName = "easynote-auto-" + stamp + "-" + Guid.NewGuid().ToString("N").Substring(0, 6);
        string fileName = baseName + ".json";
        lock (backupLock)
        {
            Directory.CreateDirectory(automaticBackupRoot);
            string finalPath = Path.Combine(automaticBackupRoot, fileName);
            WriteAtomicFile(finalPath, body);
            byte[] verified = File.ReadAllBytes(finalPath);
            if (!String.Equals(Sha256(verified), checksum, StringComparison.OrdinalIgnoreCase)) throw new IOException("Automatic backup verification failed");
            string marker = "{\"checksum\":\"" + checksum + "\",\"createdAt\":\"" + createdAt + "\",\"file\":\"" + fileName + "\"}";
            WriteAtomicFile(Path.Combine(automaticBackupRoot, baseName + ".ok"), Encoding.UTF8.GetBytes(marker));
            RotateAutomaticBackups();
        }
        string response = "{\"ok\":true,\"createdAt\":\"" + createdAt + "\",\"checksum\":\"" + checksum + "\",\"name\":\"" + fileName + "\"}";
        WriteSimpleResponse(stream, "200 OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(response), "no-store", false);
    }

    private void WriteRecoveryCandidateResponse(NetworkStream stream)
    {
        byte[] best = null;
        DateTime bestTime = DateTime.MinValue;
        lock (backupLock)
        {
            Directory.CreateDirectory(automaticBackupRoot);
            foreach (FileInfo file in new DirectoryInfo(automaticBackupRoot).GetFiles("easynote-auto-*.json"))
            {
                try
                {
                    string markerPath = Path.ChangeExtension(file.FullName, ".ok");
                    if (!File.Exists(markerPath)) continue;
                    byte[] candidate = File.ReadAllBytes(file.FullName);
                    string marker = File.ReadAllText(markerPath, Encoding.UTF8);
                    string checksum = Sha256(candidate);
                    if (!Regex.IsMatch(marker, "\\\"checksum\\\"\\s*:\\s*\\\"" + Regex.Escape(checksum) + "\\\"", RegexOptions.IgnoreCase)) continue;
                    if (best == null || candidate.Length > best.Length || (candidate.Length == best.Length && file.LastWriteTimeUtc > bestTime))
                    {
                        best = candidate;
                        bestTime = file.LastWriteTimeUtc;
                    }
                }
                catch { }
            }
        }
        if (best == null)
        {
            WriteSimpleResponse(stream, "404 Not Found", "application/json; charset=utf-8", Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"no verified backup\"}"), "no-store", false);
            return;
        }
        WriteSimpleResponse(stream, "200 OK", "application/json; charset=utf-8", best, "no-store", false);
    }

    private static void WriteAtomicFile(string finalPath, byte[] contents)
    {
        string pendingPath = finalPath + ".pending";
        using (FileStream file = new FileStream(pendingPath, FileMode.Create, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough))
        {
            file.Write(contents, 0, contents.Length);
            file.Flush(true);
        }
        if (File.Exists(finalPath)) File.Delete(finalPath);
        File.Move(pendingPath, finalPath);
    }

    private void RotateAutomaticBackups()
    {
        DirectoryInfo directory = new DirectoryInfo(automaticBackupRoot);
        FileInfo[] files = directory.GetFiles("easynote-auto-*.json");
        Array.Sort(files, delegate(FileInfo left, FileInfo right) { return right.CreationTimeUtc.CompareTo(left.CreationTimeUtc); });
        HashSet<string> keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        HashSet<string> hours = new HashSet<string>();
        HashSet<string> days = new HashSet<string>();
        DateTime hourlyCutoff = DateTime.UtcNow.AddDays(-7);
        DateTime dailyCutoff = DateTime.UtcNow.AddDays(-30);
        for (int index = 0; index < files.Length; index++)
        {
            if (index < 60) { keep.Add(files[index].FullName); continue; }
            DateTime time = files[index].CreationTimeUtc;
            string hour = time.ToString("yyyy-MM-dd-HH", CultureInfo.InvariantCulture);
            string day = time.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (time >= hourlyCutoff && hours.Add(hour)) keep.Add(files[index].FullName);
            else if (time >= dailyCutoff && days.Add(day)) keep.Add(files[index].FullName);
        }
        foreach (FileInfo file in files)
        {
            if (keep.Contains(file.FullName)) continue;
            try { File.Delete(file.FullName); } catch { continue; }
            string marker = Path.ChangeExtension(file.FullName, ".ok");
            try { if (File.Exists(marker)) File.Delete(marker); } catch { }
        }
    }

    private static string Sha256(byte[] bytes)
    {
        using (SHA256 algorithm = SHA256.Create())
        {
            byte[] digest = algorithm.ComputeHash(bytes);
            StringBuilder result = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest) result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return result.ToString();
        }
    }

    private static void WriteSimpleResponse(NetworkStream stream, string status, string contentType, byte[] body, string cacheControl, bool headOnly)
    {
        string headers = "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Cache-Control: " + cacheControl + "\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n\r\n";
        byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
        stream.Write(headerBytes, 0, headerBytes.Length);
        if (!headOnly && body.Length > 0) stream.Write(body, 0, body.Length);
        stream.Flush();
    }
}
