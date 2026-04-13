#!/usr/bin/env bash
# Slow mock claude that sleeps before responding — used to test kill/interrupt
sleep 10
echo '{"result": "slow response"}'
