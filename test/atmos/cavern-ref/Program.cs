// Reference dumper for AMC's Atmos port (AMC-original test tooling; built
// and run by scripts/atmos-cavern-ref.sh, never shipped). It is compiled
// into one assembly with Cavern.Format's sources so internal types are
// reachable; private fields are read by reflection. Cavern itself is cloned
// to /tmp at build time, never into the repo.
//   frames <in.ec3> <outDir> <n>: per-frame JOC/OAMD dump (frames.jsonl)
//                                 and Cavern's core decode (core.f32)
//   render <in.ec3> <outDir> <n>: EnhancedAC3Renderer object PCM (objects.f32)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Numerics;
using System.Reflection;
using System.Text;
using Cavern;
using Cavern.Format.Decoders;
using Cavern.Format.Decoders.EnhancedAC3;
using Cavern.Format.Renderers;
using Cavern.Format.Utilities;

static class Program {
    const BindingFlags NP = BindingFlags.NonPublic | BindingFlags.Instance;
    static T F<T>(object o, string name) => (T)o.GetType().GetField(name, NP).GetValue(o);
    static string R(float v) => float.IsNaN(v) ? "null" : v.ToString("R", CultureInfo.InvariantCulture);

    static int Main(string[] args) {
        string mode = args[0], input = args[1], outDir = args[2];
        int frames = int.Parse(args[3]);
        Directory.CreateDirectory(outDir);
        if (mode == "frames") return Frames(input, outDir, frames);
        if (mode == "render") return Render(input, outDir, frames);
        return 1;
    }

    static int Frames(string input, string outDir, int frames) {
        Listener.EnvironmentSize = Vector3.One; // positions come back normalised, no rounding
        using var stream = File.OpenRead(input);
        var decoder = new EnhancedAC3Decoder(BlockBuffer<byte>.Create(stream, 4096));
        using var json = new StreamWriter(Path.Combine(outDir, "frames.jsonl"));
        using var core = new BinaryWriter(File.Create(Path.Combine(outDir, "core.f32")));
        var sources = new Dictionary<int, Source>();
        int channels = decoder.ChannelCount;
        float[] block = new float[1536 * channels];
        Dump(json, decoder, 0, sources);
        for (int k = 0; k < frames; ++k) {
            decoder.DecodeBlock(block, 0, block.Length);
            foreach (float v in block) core.Write(v);
            if (k + 1 < frames) Dump(json, decoder, k + 1, sources);
        }
        Console.Error.WriteLine($"frames: {frames}, core channels {channels} ({string.Join(",", decoder.GetChannels())})");
        return 0;
    }

    static void Dump(StreamWriter w, EnhancedAC3Decoder d, int k, Dictionary<int, Source> sources) {
        var ext = d.Extensions;
        var sb = new StringBuilder();
        sb.Append("{\"k\":").Append(k).Append(",\"hasObjects\":").Append(ext.HasObjects ? "true" : "false");
        var joc = ext.JOC;
        if (ext.HasObjects) {
            sb.Append(",\"joc\":{\"ch\":").Append(joc.ChannelCount).Append(",\"obj\":").Append(joc.ObjectCount)
              .Append(",\"gain\":").Append(R(joc.Gain));
            bool[] active = joc.ObjectActive;
            byte[] bandsIndex = F<byte[]>(joc, "bandsIndex"), bands = F<byte[]>(joc, "bands"), quant = F<byte[]>(joc, "quantizationTable");
            bool[] sparse = F<bool[]>(joc, "sparseCoded"), steep = F<bool[]>(joc, "steepSlope");
            int[] dp = F<int[]>(joc, "dataPoints");
            int[][] offsets = F<int[][]>(joc, "timeslotOffsets");
            int[][][][] matrix = F<int[][][][]>(joc, "jocMatrix");
            sb.Append(",\"objects\":[");
            for (int o = 0; o < joc.ObjectCount; ++o) {
                if (o > 0) sb.Append(',');
                sb.Append("{\"a\":").Append(active[o] ? 1 : 0);
                if (active[o]) {
                    sb.Append(",\"bi\":").Append(bandsIndex[o]).Append(",\"sp\":").Append(sparse[o] ? 1 : 0)
                      .Append(",\"q\":").Append(quant[o]).Append(",\"st\":").Append(steep[o] ? 1 : 0).Append(",\"dp\":").Append(dp[o]);
                    if (steep[o]) { sb.Append(",\"off\":[").Append(offsets[o][0]); if (dp[o] > 1) sb.Append(',').Append(offsets[o][1]); sb.Append(']'); }
                    if (!sparse[o]) {
                        sb.Append(",\"m\":[");
                        for (int p = 0; p < dp[o]; ++p) {
                            if (p > 0) sb.Append(',');
                            sb.Append('[');
                            for (int c = 0; c < joc.ChannelCount; ++c) {
                                if (c > 0) sb.Append(',');
                                sb.Append('[');
                                for (int b = 0; b < bands[o]; ++b) { if (b > 0) sb.Append(','); sb.Append(matrix[o][p][c][b]); }
                                sb.Append(']');
                            }
                            sb.Append(']');
                        }
                        sb.Append(']');
                    }
                }
                sb.Append('}');
            }
            sb.Append("]}");
        }
        var oamd = ext.OAMD;
        if (oamd.ObjectCount > 0) {
            sb.Append(",\"oamd\":{\"n\":").Append(oamd.ObjectCount).Append(",\"beds\":").Append(oamd.Beds)
              .Append(",\"lfe\":").Append(oamd.GetLFEPosition()).Append(",\"offset\":").Append(F<int>(oamd, "offset"))
              .Append(",\"static\":[").Append(string.Join(",", Array.ConvertAll(oamd.GetStaticChannels(), c => ((int)c).ToString()))).Append(']');
            var elements = F<OAElementMD[]>(oamd, "elements");
            sb.Append(",\"el\":[");
            for (int e = 0; e < elements.Length; ++e) {
                if (e > 0) sb.Append(',');
                var el = elements[e];
                short[] bof = F<short[]>(el, "blockOffsetFactor");
                sb.Append("{\"min\":").Append(el.MinOffset).Append(",\"bof\":[").Append(string.Join(",", bof)).Append(']');
                if (el.MinOffset >= 0) {
                    short[] ramps = F<short[]>(el, "rampDuration");
                    var infoBlocks = F<ObjectInfoBlock[][]>(el, "infoBlocks");
                    sb.Append(",\"ramp\":[").Append(string.Join(",", ramps)).Append("],\"blk\":[");
                    for (int b = 0; b < ramps.Length; ++b) {
                        if (b > 0) sb.Append(',');
                        sb.Append('[');
                        for (int o = 0; o < infoBlocks.Length; ++o) {
                            if (o > 0) sb.Append(',');
                            if (!sources.TryGetValue(o, out Source src)) { src = new Source { Volume = .707f }; sources[o] = src; }
                            Vector3 pos = infoBlocks[o][b].UpdateSource(src);
                            sb.Append("{\"v\":").Append(infoBlocks[o][b].ValidPosition ? 1 : 0).Append(",\"bed\":").Append(infoBlocks[o][b].IsBed ? 1 : 0)
                              .Append(",\"x\":").Append(R(pos.X)).Append(",\"y\":").Append(R(pos.Y)).Append(",\"z\":").Append(R(pos.Z))
                              .Append(",\"g\":").Append(R(src.Volume)).Append(",\"s\":").Append(R(src.Size)).Append('}');
                        }
                        sb.Append(']');
                    }
                    sb.Append(']');
                }
                sb.Append('}');
            }
            sb.Append("]}");
        }
        sb.Append('}');
        w.WriteLine(sb.ToString());
    }

    static int Render(string input, string outDir, int frames) {
        using var stream = File.OpenRead(input);
        var decoder = new EnhancedAC3Decoder(BlockBuffer<byte>.Create(stream, 4096));
        var renderer = new EnhancedAC3Renderer(decoder);
        using var pcm = new BinaryWriter(File.Create(Path.Combine(outDir, "objects.f32")));
        int n = renderer.Objects.Count;
        Console.Error.WriteLine($"render: objects {n}, dynamic {renderer.DynamicObjects}, hasObjects {renderer.HasObjects}");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        for (int k = 0; k < frames; ++k) {
            float[][] objs = renderer.GetNextObjectSamples(1536);
            for (int i = 0; i < 1536; ++i)
                for (int o = 0; o < n; ++o) pcm.Write(objs[o][i]);
        }
        Console.Error.WriteLine($"rendered {frames} frames in {sw.ElapsedMilliseconds} ms; WorkedAround(sparse)={renderer.WorkedAround}");
        File.WriteAllText(Path.Combine(outDir, "render.json"), $"{{\"objects\":{n},\"dynamic\":{renderer.DynamicObjects}}}");
        return 0;
    }
}
