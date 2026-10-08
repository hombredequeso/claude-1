# Skill                                         
**`/load-test`**                              

# What it catches                                                                        

Throughput limit, latency at that limit, what saturates first

# How

Wrap `run.sh` the way `/profile` wraps its runner. Read `run.json`, `timeseries.csv` and pidstat, and report whether CPU, the event loop or GC gave out first.


