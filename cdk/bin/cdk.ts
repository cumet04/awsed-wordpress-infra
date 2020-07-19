#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { CdkStack } from "../lib/cdk-stack";
import { env } from "process";

const app = new cdk.App();
new CdkStack(
  app,
  "CdkStack",
  {
    frontCertArn: env.FRONT_CERT_ARN!,
    albDomain: "lb.wordpress.example.com",
    albCertArn: env.ALB_CERT_ARN!,
    albKeyName: "x-alb-pre-shared-key",
    albKeyValue: env.ALB_KEY_VALUE!,
    isOnwerOnly: env.IS_OWNER_ONLY! == "1",
    dbName: "wordpress",
    dbUser: "wordpress",
    amiName: "wordpress",
    ownerIps: env.OWNER_IPS!.split(",").map((s) => s.trim()),
  },
  {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  }
);
