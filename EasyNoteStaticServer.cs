using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

public sealed class EasyNoteStaticServer
{
    private readonly string root;
    private readonly string rootPrefix;
    private readonly TcpListener listener;
    private volatile bool stopping;

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

    public EasyNoteStaticServer(string appRoot, int port)
    {
        root = Path.GetFullPath(appRoot);
        rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        listener = new TcpListener(IPAddress.Loopback, port);
    }

    public void Start()
    {
        listener.Start(64);
    }

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
                client.ReceiveTimeout = 3000;
                client.SendTimeout = 5000;
                using (NetworkStream stream = client.GetStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true))
                {
                    string requestLine = reader.ReadLine();
                    if (String.IsNullOrWhiteSpace(requestLine)) return;
                    string headerLine;
                    do { headerLine = reader.ReadLine(); } while (!String.IsNullOrEmpty(headerLine));
                    WriteResponse(stream, requestLine);
                }
            }
            catch (IOException) { }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }
    }

    private void WriteResponse(NetworkStream stream, string requestLine)
    {
        string[] parts = requestLine.Split(' ');
        string method = parts.Length > 0 ? parts[0] : "";
        string rawTarget = parts.Length > 1 ? parts[1] : "/";
        string pathOnly = rawTarget.Split('?')[0];
        string relative = Uri.UnescapeDataString(pathOnly).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        if (String.IsNullOrWhiteSpace(relative)) relative = "index.html";

        string status = "200 OK";
        string contentType = "application/octet-stream";
        string cacheControl = "no-cache";
        byte[] body;
        string candidate = Path.GetFullPath(Path.Combine(root, relative));

        if (method != "GET" && method != "HEAD")
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
            string extension = Path.GetExtension(candidate);
            string knownType;
            if (MimeTypes.TryGetValue(extension, out knownType)) contentType = knownType;
            if (relative.StartsWith("assets" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                relative.StartsWith("icons" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                relative.StartsWith("workbox-", StringComparison.OrdinalIgnoreCase))
            {
                cacheControl = "public, max-age=31536000, immutable";
            }
        }

        string headers = "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Cache-Control: " + cacheControl + "\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Connection: close\r\n\r\n";
        byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
        stream.Write(headerBytes, 0, headerBytes.Length);
        if (method != "HEAD" && body.Length > 0) stream.Write(body, 0, body.Length);
        stream.Flush();
    }
}
