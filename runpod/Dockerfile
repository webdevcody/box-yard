# Box Yard's RunPod GPU image: the tools agents need, preinstalled so a pod is ready seconds after it starts.
# Built by each Box Yard install with its own Docker (Settings › RunPod GPU › Build image) and pushed to its own
# registry. It holds only public tools: never add a key, token or ARG/ENV that carries one.
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
# Start on any host driver; the CUDA runtime here is forward compatible within 12.x.
ENV NVIDIA_DISABLE_REQUIRE=1 NVIDIA_DRIVER_CAPABILITIES=all DISABLE_AUTOUPDATER=1 IS_SANDBOX=1 LANG=C.UTF-8
COPY bootstrap.sh /opt/boxyard/bootstrap.sh
RUN bash /opt/boxyard/bootstrap.sh
COPY init.sh watchdog.sh start.sh /opt/boxyard/
RUN chmod +x /opt/boxyard/*.sh
CMD ["/opt/boxyard/start.sh"]
