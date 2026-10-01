# tools

Research and benchmark harnesses: the optional Python services (`matcher`, `nearfield`), the terrain-matching and concordance experiments (`concord`, `research`, `bench`), and OSM helpers. None of it is needed to run the app.

Checkpoint and cache loaders here (`torch.load`, `np.load(..., allow_pickle=True)`) deserialise pickles, which can execute code. Use them only on trusted local files that you produced or downloaded from a source you trust, and never on files from an untrusted party.
