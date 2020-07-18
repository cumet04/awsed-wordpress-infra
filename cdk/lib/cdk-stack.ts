import * as cdk from "@aws-cdk/core";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as asg from "@aws-cdk/aws-autoscaling";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as efs from "@aws-cdk/aws-efs";
import * as iam from "@aws-cdk/aws-iam";
import * as rds from "@aws-cdk/aws-rds";

interface IParams {
  albCertArn: string;
  dbName: string;
  dbUser: string;
  amiName: string;
}

export class CdkStack extends cdk.Stack {
  constructor(
    scope: cdk.Construct,
    id: string,
    params: IParams,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgEFS,
    } = this.createVpc();

    this.createRDS(
      vpc,
      sgDB,
      snData,
      ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      params.dbName,
      params.dbUser,
      10
    );
    const efs = this.createEFS(vpc, snData, sgEFS);

    // S3 for backup
    const group = this.createInstances(
      vpc,
      snApp,
      sgApp,
      params.amiName,
      ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      8,
      efs.fileSystemId
    );
    // cloudwatch

    this.createALB(vpc, sgALB, snIngress, group, params.albCertArn);

    // WAF
    // Cloudfront
  }

  createVpc(): {
    vpc: ec2.Vpc;
    snIngress: ec2.SubnetSelection;
    snApp: ec2.SubnetSelection;
    snData: ec2.SubnetSelection;
    sgALB: ec2.SecurityGroup;
    sgApp: ec2.SecurityGroup;
    sgDB: ec2.SecurityGroup;
    sgEFS: ec2.SecurityGroup;
  } {
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/24",
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Ingress",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: "Data",
          subnetType: ec2.SubnetType.ISOLATED,
        },
        {
          name: "App",
          subnetType: ec2.SubnetType.ISOLATED,
        },
      ],
    });

    // subnets ---
    const snIngress = vpc.selectSubnets({ subnetGroupName: "Ingress" });
    const snApp = vpc.selectSubnets({ subnetGroupName: "App" });
    const snData = vpc.selectSubnets({ subnetGroupName: "Data" });

    // security groups ---
    const sgALB = new ec2.SecurityGroup(this, "sgALB", { vpc });
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    // TODO: IP絞る; WAF?

    const sgApp = new ec2.SecurityGroup(this, "sgApp", { vpc });
    sgApp.addIngressRule(sgALB, ec2.Port.tcp(80));

    const sgDB = new ec2.SecurityGroup(this, "sgDB", { vpc });
    sgDB.addIngressRule(sgApp, ec2.Port.tcp(3306));

    const sgEFS = new ec2.SecurityGroup(this, "sgEFS", { vpc });
    sgEFS.addIngressRule(sgApp, ec2.Port.tcp(2049));

    // VPC endpoints ---
    Object.entries({
      vpcLogsEndpoint: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      vpcEc2mEndpoint: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      vpcSsmmEndpoint: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    }).forEach(([key, value]) => {
      vpc.addInterfaceEndpoint(key, {
        service: value,
        subnets: vpc.selectSubnets({ subnetGroupName: "App" }),
      });
    });
    vpc.addS3Endpoint("vpcS3Endpoint", [snApp]);

    return {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgEFS,
    };
  }

  createRDS(
    vpc: ec2.Vpc,
    sg: ec2.SecurityGroup,
    subnets: ec2.SubnetSelection,
    instanceType: ec2.InstanceType,
    dbName: string,
    dbUser: string,
    storageSize: number
  ): rds.DatabaseInstance {
    const db = new rds.DatabaseInstance(this, "RDS", {
      vpc,
      vpcPlacement: subnets,
      securityGroups: [sg],
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_30,
      }),
      instanceType,
      multiAz: false, // TODO: for development
      deletionProtection: false, // TODO: for development
      masterUsername: dbUser,
      databaseName: dbName,
      allocatedStorage: storageSize,
      parameterGroup: new rds.ParameterGroup(this, "rdsParamGroup", {
        engine: rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_5_7_30,
        }),
        parameters: {
          character_set_client: "utf8",
          character_set_connection: "utf8",
          character_set_database: "utf8",
          character_set_server: "utf8",
          collation_connection: "utf8_bin",
          collation_server: "utf8_bin",
        },
      }),
    });

    return db;
  }

  createEFS(vpc: ec2.Vpc, subnets: ec2.SubnetSelection, sg: ec2.SecurityGroup) {
    return new efs.FileSystem(this, "ContentsStorage", {
      vpc,
      vpcSubnets: subnets,
      securityGroup: sg,
      fileSystemName: "wordpress",
    });
  }

  createInstances(
    vpc: ec2.Vpc,
    vpcSubnets: ec2.SubnetSelection,
    securityGroup: ec2.SecurityGroup,
    amiName: string,
    instanceType: ec2.InstanceType,
    volumeSize: number,
    efsId: string
  ): asg.AutoScalingGroup {
    const role = new iam.Role(this, "IAMRoleEC2", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonEC2RoleforSSM"
        ),
      ],
    });

    const userData = ec2.UserData.custom(`#!/bin/bash
yum update -y --security

echo "${efsId}:/ /var/www/html efs tls,_netdev" >> /etc/fstab
mount -a -t efs defaults
`);

    const group = new asg.AutoScalingGroup(this, "AutoscalingGroup", {
      vpc,
      vpcSubnets,
      securityGroup,
      instanceType,
      role,
      allowAllOutbound: false,
      minCapacity: 2,
      maxCapacity: 4,
      machineImage: new ec2.LookupMachineImage({
        name: amiName,
        filters: { "owner-id": [this.account] },
      }),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: {
            ebsDevice: {
              volumeSize,
              deleteOnTermination: true,
              volumeType: asg.EbsDeviceVolumeType.GP2,
            },
          },
        },
      ],
      userData,
    });
    return group;
  }

  createALB(
    vpc: ec2.Vpc,
    sg: ec2.SecurityGroup,
    subnets: ec2.SubnetSelection,
    group: asg.AutoScalingGroup,
    certArn: string
  ) {
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      vpcSubnets: subnets,
      internetFacing: true,
      securityGroup: sg,
    });
    alb
      .addListener("albListner80", { port: 80 })
      .addRedirectResponse("albListener80RedirectResponse", {
        protocol: "HTTPS",
        port: "443",
        statusCode: "HTTP_301",
      });
    alb
      .addListener("albListner443", {
        port: 443,
        certificateArns: [certArn],
      })
      .addTargets("albtgApp", {
        targets: [group],
        protocol: elbv2.ApplicationProtocol.HTTP,
        healthCheck: {
          path: "/",
          healthyHttpCodes: "200,302",
          interval: cdk.Duration.seconds(60),
          timeout: cdk.Duration.seconds(30),
        },
      });
  }
}
